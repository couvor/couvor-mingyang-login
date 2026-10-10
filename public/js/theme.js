(function () {
  var btn = document.querySelector('.theme-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var light = document.documentElement.classList.toggle('light');
    try {
      localStorage.setItem('theme', light ? 'light' : 'dark');
    } catch (e) {}
  });
})();
