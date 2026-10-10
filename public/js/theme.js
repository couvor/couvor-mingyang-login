(function () {
  var btn = document.querySelector('.theme-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var dark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch (e) {}
  });
})();
