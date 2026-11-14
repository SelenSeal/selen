// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SelenBridge} from "../src/SelenBridge.sol";

contract MockToken {
    string public symbol;
    uint8 public decimals;
    uint256 public feeBps; // transfer fee taken by the token itself
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory s, uint8 d, uint256 fee) { symbol = s; decimals = d; feeBps = fee; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        _move(f, to, a);
        return true;
    }
    function _move(address f, address to, uint256 a) internal {
        balanceOf[f] -= a;
        uint256 fee = (a * feeBps) / 10_000;
        balanceOf[to] += a - fee;
    }
}

contract FalseToken {
    mapping(address => uint256) public balanceOf;
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

contract SelenBridgeTest is Test {
    SelenBridge bridge;
    MockToken usdg; // 6 decimals → asset 1, unit 1
    MockToken selen; // 18 decimals → asset 0, unit 1e10 (8 decimals on the SELEN chain)
    address op = address(0x09E7A70);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 dest = sha256("selenq1example");

    function setUp() public {
        bridge = new SelenBridge(op);
        usdg = new MockToken("USDG", 6, 0);
        selen = new MockToken("SELEN", 18, 0);
        bridge.setToken(address(usdg), true, 1, 1, 1_000_000e6, 100_000e6);
        bridge.setToken(address(selen), true, 0, 1e10, 1_000_000_000e18, 10_000_000e18);
        usdg.mint(alice, 10_000e6);
        selen.mint(alice, 50_000e18);
        vm.startPrank(alice);
        usdg.approve(address(bridge), type(uint256).max);
        selen.approve(address(bridge), type(uint256).max);
        vm.stopPrank();
    }

    function test_lockEmitsAndCounts() public {
        vm.expectEmit(true, true, true, true);
        emit SelenBridge.Locked(1, address(usdg), alice, 250e6, dest);
        vm.prank(alice);
        uint256 id = bridge.lock(address(usdg), 250e6, dest);
        assertEq(id, 1);
        assertEq(bridge.tokenInfo(address(usdg)).locked, 250e6);
        assertEq(usdg.balanceOf(address(bridge)), 250e6);
    }

    function test_lockRoundsToWholeSelenUnits() public {
        vm.prank(alice);
        bridge.lock(address(selen), 1e18 + 123, dest); // 123 wei below one unit stays as surplus
        assertEq(bridge.tokenInfo(address(selen)).locked, 1e18);
        assertEq(selen.balanceOf(address(bridge)), 1e18 + 123);
        vm.prank(alice);
        vm.expectRevert(SelenBridge.BelowOneUnit.selector);
        bridge.lock(address(selen), 1e10 - 1, dest);
    }

    function test_feeOnTransferCreditsWhatArrived() public {
        MockToken taxed = new MockToken("TAX", 18, 200); // 2 %
        bridge.setToken(address(taxed), true, 2, 1e10, type(uint128).max, type(uint128).max);
        taxed.mint(alice, 100e18);
        vm.startPrank(alice);
        taxed.approve(address(bridge), type(uint256).max);
        bridge.lock(address(taxed), 100e18, dest);
        vm.stopPrank();
        assertEq(bridge.tokenInfo(address(taxed)).locked, 98e18);
    }

    function test_releasePaysOnceAndReducesLocked() public {
        vm.prank(alice);
        bridge.lock(address(usdg), 1_000e6, dest);
        bytes32 ref = keccak256("selen-tx:0");
        vm.prank(op);
        bridge.release(address(usdg), bob, 400e6, ref);
        assertEq(usdg.balanceOf(bob), 400e6);
        assertEq(bridge.tokenInfo(address(usdg)).locked, 600e6);
        assertTrue(bridge.released(ref));
        vm.prank(op);
        vm.expectRevert(SelenBridge.AlreadyReleased.selector);
        bridge.release(address(usdg), bob, 1e6, ref);
    }

    function test_onlyOperatorReleases() public {
        vm.prank(alice);
        bridge.lock(address(usdg), 10e6, dest);
        vm.prank(alice);
        vm.expectRevert(SelenBridge.NotOperator.selector);
        bridge.release(address(usdg), alice, 10e6, bytes32(uint256(1)));
        vm.expectRevert(SelenBridge.NotOperator.selector); // the owner cannot release either
        bridge.release(address(usdg), address(this), 10e6, bytes32(uint256(1)));
    }

    function test_releaseNeverExceedsLocked() public {
        vm.prank(alice);
        bridge.lock(address(usdg), 10e6, dest);
        usdg.mint(address(bridge), 1_000e6); // surplus sent by mistake is not owed to anyone
        vm.prank(op);
        vm.expectRevert(SelenBridge.MoreThanLocked.selector);
        bridge.release(address(usdg), bob, 11e6, bytes32(uint256(2)));
    }

    function test_releaseAmountMustBeWholeUnits() public {
        vm.prank(alice);
        bridge.lock(address(selen), 10e18, dest);
        vm.prank(op);
        vm.expectRevert(SelenBridge.BadAmount.selector);
        bridge.release(address(selen), bob, 1e10 + 1, bytes32(uint256(3)));
    }

    function test_dailyLimitResetsAfterADay() public {
        bridge.setToken(address(usdg), true, 1, 1, 1_000_000e6, 500e6);
        vm.prank(alice);
        bridge.lock(address(usdg), 2_000e6, dest);
        vm.startPrank(op);
        bridge.release(address(usdg), bob, 500e6, bytes32(uint256(10)));
        vm.expectRevert(SelenBridge.DailyLimit.selector);
        bridge.release(address(usdg), bob, 1e6, bytes32(uint256(11)));
        vm.warp(block.timestamp + 1 days);
        bridge.release(address(usdg), bob, 500e6, bytes32(uint256(11)));
        vm.stopPrank();
        assertEq(usdg.balanceOf(bob), 1_000e6);
    }

    function test_capStopsNewLocks() public {
        bridge.setToken(address(usdg), true, 1, 1, 300e6, 100_000e6);
        vm.startPrank(alice);
        bridge.lock(address(usdg), 300e6, dest);
        vm.expectRevert(SelenBridge.CapReached.selector);
        bridge.lock(address(usdg), 1e6, dest);
        vm.stopPrank();
    }

    function test_disabledTokenStillReleases() public {
        vm.prank(alice);
        bridge.lock(address(usdg), 100e6, dest);
        bridge.setToken(address(usdg), false, 1, 1, 1_000_000e6, 100_000e6);
        vm.prank(alice);
        vm.expectRevert(SelenBridge.TokenOff.selector);
        bridge.lock(address(usdg), 1e6, dest);
        vm.prank(op);
        bridge.release(address(usdg), alice, 100e6, bytes32(uint256(4)));
        assertEq(usdg.balanceOf(alice), 10_000e6);
    }

    function test_mappingIsFixed() public {
        vm.expectRevert(SelenBridge.MappingFixed.selector);
        bridge.setToken(address(selen), true, 0, 1e9, 1, 1);
        vm.expectRevert(SelenBridge.MappingFixed.selector);
        bridge.setToken(address(usdg), true, 2, 1, 1, 1);
    }

    function test_pauseStopsBothWays() public {
        vm.prank(alice);
        bridge.lock(address(usdg), 10e6, dest);
        bridge.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(SelenBridge.IsPaused.selector);
        bridge.lock(address(usdg), 1e6, dest);
        vm.prank(op);
        vm.expectRevert(SelenBridge.IsPaused.selector);
        bridge.release(address(usdg), bob, 1e6, bytes32(uint256(5)));
        bridge.setPaused(false);
        vm.prank(op);
        bridge.release(address(usdg), bob, 1e6, bytes32(uint256(5)));
    }

    function test_ownerSweepsOnlySurplus() public {
        vm.prank(alice);
        bridge.lock(address(usdg), 700e6, dest);
        usdg.mint(address(bridge), 5e6);
        uint256 got = bridge.sweepSurplus(address(usdg), address(this));
        assertEq(got, 5e6);
        assertEq(usdg.balanceOf(address(bridge)), 700e6);
        assertEq(bridge.sweepSurplus(address(usdg), address(this)), 0);
    }

    function test_rejectsFalseReturningToken() public {
        FalseToken f = new FalseToken();
        bridge.setToken(address(f), true, 3, 1, 1e30, 1e30);
        vm.prank(alice);
        vm.expectRevert(SelenBridge.TransferFailed.selector);
        bridge.lock(address(f), 1, dest);
    }

    function test_twoStepOwnership() public {
        bridge.transferOwnership(bob);
        assertEq(bridge.owner(), address(this));
        vm.prank(alice);
        vm.expectRevert(SelenBridge.NotOwner.selector);
        bridge.acceptOwnership();
        vm.prank(bob);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), bob);
        vm.expectRevert(SelenBridge.NotOwner.selector);
        bridge.setPaused(true);
    }

    function test_settingsAreOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(SelenBridge.NotOwner.selector);
        bridge.setToken(address(usdg), true, 1, 1, 1, 1);
        vm.expectRevert(SelenBridge.NotOwner.selector);
        bridge.setOperator(alice);
        vm.expectRevert(SelenBridge.NotOwner.selector);
        bridge.sweepSurplus(address(usdg), alice);
        vm.stopPrank();
    }

    /// whatever is locked and released, the contract always holds at least what it owes
    function testFuzz_solvent(uint96 a, uint96 b, uint96 r) public {
        uint256 la = bound(a, 1, 5_000e6);
        uint256 lb = bound(b, 1, 4_000e6);
        vm.startPrank(alice);
        bridge.lock(address(usdg), la, dest);
        bridge.lock(address(usdg), lb, dest);
        vm.stopPrank();
        uint256 rel = bound(r, 1, la + lb);
        vm.prank(op);
        bridge.release(address(usdg), bob, rel, keccak256(abi.encode(r)));
        assertGe(usdg.balanceOf(address(bridge)), bridge.tokenInfo(address(usdg)).locked);
        assertEq(bridge.tokenInfo(address(usdg)).locked, la + lb - rel);
    }
}

/// Against real USDG on a Robinhood Chain fork:
///   forge test --match-contract Fork --fork-url https://robinhood-rpc.publicnode.com
contract SelenBridgeForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function test_realUsdgLockAndRelease() public {
        if (block.chainid != 4663) return; // only meaningful on a Robinhood Chain fork
        address op = makeAddr("operator");
        address user = makeAddr("user");
        address to = makeAddr("to");
        SelenBridge bridge = new SelenBridge(op);
        bridge.setToken(USDG, true, 1, 1, 1_000_000e6, 100_000e6);
        deal(USDG, user, 1_234e6);
        vm.startPrank(user);
        (bool ok,) = USDG.call(abi.encodeWithSignature("approve(address,uint256)", address(bridge), type(uint256).max));
        assertTrue(ok);
        bridge.lock(USDG, 1_234e6, sha256("selenq1forktest"));
        vm.stopPrank();
        assertEq(bridge.tokenInfo(USDG).locked, 1_234e6);
        vm.prank(op);
        bridge.release(USDG, to, 1_000e6, keccak256("ref"));
        (, bytes memory ret) = USDG.staticcall(abi.encodeWithSignature("balanceOf(address)", to));
        assertEq(abi.decode(ret, (uint256)), 1_000e6);
    }
}
