(function(){
  const navBar=document.getElementById('site-nav');
  const menu=document.getElementById('nav-menu');
  if(!navBar||!menu)return;
  const toggle=navBar.querySelector('.nav-toggle');
  if(!toggle)return;

  function closeMenu(){
    navBar.classList.remove('is-open');
    toggle.setAttribute('aria-expanded','false');
    toggle.setAttribute('aria-label','Open menu');
    document.body.classList.remove('nav-open');
  }

  function openMenu(){
    navBar.classList.add('is-open');
    toggle.setAttribute('aria-expanded','true');
    toggle.setAttribute('aria-label','Close menu');
    document.body.classList.add('nav-open');
  }

  toggle.addEventListener('click',()=>{
    if(navBar.classList.contains('is-open'))closeMenu();
    else openMenu();
  });

  menu.querySelectorAll('a').forEach(link=>{
    link.addEventListener('click',closeMenu);
  });

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape')closeMenu();
  });
})();
