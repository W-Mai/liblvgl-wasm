(() => {
  const root = document.documentElement;
  root.classList.add("js");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  let frame = 0;
  const updateScrollState = () => {
    frame = 0;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const progress = maxScroll > 0 ? clamp(window.scrollY / maxScroll, 0, 1) : 0;
    root.style.setProperty("--scroll-progress", progress.toFixed(4));
    document.body.dataset.scrolled = window.scrollY > 6 ? "true" : "false";

    if (reduceMotion.matches) return;
    const preview = document.querySelector("[data-depth]");
    if (!preview || !preview.classList.contains("is-visible")) return;
    const bounds = preview.getBoundingClientRect();
    const centerOffset = (window.innerHeight / 2 - (bounds.top + bounds.height / 2)) / window.innerHeight;
    preview.style.setProperty("--scroll-shift", `${clamp(centerOffset * -10, -12, 12).toFixed(2)}px`);
  };

  const requestScrollUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(updateScrollState);
  };
  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  window.addEventListener("resize", requestScrollUpdate, { passive: true });
  updateScrollState();

  const revealItems = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8%", threshold: 0.12 });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  if (window.matchMedia("(pointer: fine)").matches && !reduceMotion.matches) {
    document.querySelectorAll(".feature-card").forEach((card) => {
      card.addEventListener("pointermove", (event) => {
        const bounds = card.getBoundingClientRect();
        card.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
        card.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
      });
    });

    const device = document.querySelector(".device-wrap");
    const stage = document.querySelector(".preview-stage");
    stage?.addEventListener("pointermove", (event) => {
      if (!device) return;
      const bounds = stage.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      device.style.setProperty("--tilt-x", `${clamp(y * -2.4, -2.4, 2.4).toFixed(2)}deg`);
      device.style.setProperty("--tilt-y", `${clamp(x * 3.2, -3.2, 3.2).toFixed(2)}deg`);
    });
    stage?.addEventListener("pointerleave", () => {
      device?.style.setProperty("--tilt-x", "0deg");
      device?.style.setProperty("--tilt-y", "0deg");
    });
  }

  document.querySelector("[data-copy]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.classList.add("is-copied");
    window.setTimeout(() => button.classList.remove("is-copied"), 1250);
  });
})();
