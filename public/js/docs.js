import { $, $$, esc } from "/js/common.js";

const ca = (window.SITE || {}).ca;
const line = $("#ca-line");
if (line && ca) line.innerHTML = `Contract address: <button class="chip" data-copy="${esc(ca)}"><b>${esc(ca)}</b></button>`;

const links = $$("#toc a");
const io = new IntersectionObserver((es) => {
  es.forEach((e) => {
    if (e.isIntersecting) links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id));
  });
}, { rootMargin: "-30% 0px -60% 0px" });
$$(".doc section").forEach((s) => io.observe(s));
