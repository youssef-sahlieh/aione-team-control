(function () {
  fetch("/api/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => { if (me) document.getElementById("me").textContent = me.email; })
    .catch(() => {});
})();
