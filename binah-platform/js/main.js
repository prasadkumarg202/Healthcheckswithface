/**
 * Binah.ai Platform Interactive Scripts (ES6+ / jQuery Compatible)
 * Features:
 *  1. Sticky Navigation on Scroll with throttling
 *  2. Mobile Mega Menu Drawer & Accordions
 *  3. WPML Language Switcher Dropdown
 *  4. RioVizual/FaceMesh Canvas Simulation with scanlines and dynamic vitals
 *  5. Indicator Category Tabs Filtering
 *  6. HubSpot Form Validation & Real-time Feedback
 *  7. Complianz GDPR Cookie Consent Manager
 */

document.addEventListener('DOMContentLoaded', () => {
  initStickyNav();
  initMobileMenu();
  initLanguageSwitcher();
  initFaceMeshSimulation();
  initIndicatorTabs();
  initHubSpotForm();
  initCookieConsent();
  initSmoothScroll();
});

/* ==========================================================================
   1. Sticky Navigation on Scroll
   ========================================================================== */
function initStickyNav() {
  const mainNav = document.getElementById('mainNavWrapper');
  if (!mainNav) return;

  const stickyThreshold = 60;
  let lastScrollY = window.scrollY;
  let ticking = false;

  window.addEventListener('scroll', () => {
    lastScrollY = window.scrollY;
    if (!ticking) {
      window.requestAnimationFrame(() => {
        if (lastScrollY > stickyThreshold) {
          mainNav.classList.add('is-sticky');
        } else {
          mainNav.classList.remove('is-sticky');
        }
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

/* ==========================================================================
   2. Mobile Hamburger Menu & Dropdowns
   ========================================================================== */
function initMobileMenu() {
  const toggleBtn = document.getElementById('mobileNavToggle');
  const navMenu = document.getElementById('navMenuDesktop');
  if (!toggleBtn || !navMenu) return;

  toggleBtn.addEventListener('click', () => {
    const isOpen = navMenu.classList.toggle('mobile-active');
    toggleBtn.innerHTML = isOpen
      ? '<i class="fa fa-times" aria-hidden="true"></i>'
      : '<i class="fa fa-bars" aria-hidden="true"></i>';
  });
}

/* ==========================================================================
   3. WPML Language Switcher Dropdown
   ========================================================================== */
function initLanguageSwitcher() {
  const langSelector = document.getElementById('wpmlLangSelector');
  const dropdown = document.getElementById('wpmlDropdown');
  if (!langSelector || !dropdown) return;

  langSelector.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('active');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('active');
  });
}

/* ==========================================================================
   4. RioVizual / FaceMesh Canvas Simulation
   ========================================================================== */
function initFaceMeshSimulation() {
  const canvas = document.getElementById('faceSimCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let width = (canvas.width = canvas.parentElement.clientWidth);
  let height = (canvas.height = canvas.parentElement.clientHeight);

  window.addEventListener('resize', () => {
    if (!canvas.parentElement) return;
    width = canvas.width = canvas.parentElement.clientWidth;
    height = canvas.height = canvas.parentElement.clientHeight;
  });

  // Simulated 3D facial landmark mesh points
  const landmarks = [
    // Forehead
    { x: 0.5, y: 0.2 }, { x: 0.42, y: 0.22 }, { x: 0.58, y: 0.22 },
    { x: 0.35, y: 0.28 }, { x: 0.65, y: 0.28 },
    // Eyes
    { x: 0.38, y: 0.4 }, { x: 0.44, y: 0.41 }, { x: 0.41, y: 0.38 },
    { x: 0.62, y: 0.4 }, { x: 0.56, y: 0.41 }, { x: 0.59, y: 0.38 },
    // Nose
    { x: 0.5, y: 0.35 }, { x: 0.5, y: 0.48 }, { x: 0.46, y: 0.56 }, { x: 0.54, y: 0.56 },
    // Cheeks (rPPG ROI points)
    { x: 0.32, y: 0.52 }, { x: 0.28, y: 0.6 }, { x: 0.36, y: 0.64 },
    { x: 0.68, y: 0.52 }, { x: 0.72, y: 0.6 }, { x: 0.64, y: 0.64 },
    // Mouth
    { x: 0.42, y: 0.7 }, { x: 0.58, y: 0.7 }, { x: 0.5, y: 0.68 }, { x: 0.5, y: 0.74 },
    // Chin & Jawline
    { x: 0.5, y: 0.88 }, { x: 0.38, y: 0.84 }, { x: 0.62, y: 0.84 },
    { x: 0.26, y: 0.75 }, { x: 0.74, y: 0.75 }
  ];

  let frame = 0;

  function renderMesh() {
    ctx.clearRect(0, 0, width, height);

    // Subtle background mesh grid
    ctx.strokeStyle = 'rgba(0, 180, 216, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const t = frame * 0.03;
    const currentPoints = landmarks.map(pt => ({
      x: pt.x * width + Math.sin(t + pt.y * 5) * 3,
      y: pt.y * height + Math.cos(t + pt.x * 5) * 2
    }));

    // Connect mesh triangulation
    ctx.strokeStyle = 'rgba(0, 180, 216, 0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i < currentPoints.length; i++) {
      for (let j = i + 1; j < currentPoints.length; j++) {
        const dx = currentPoints[i].x - currentPoints[j].x;
        const dy = currentPoints[i].y - currentPoints[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 65) {
          ctx.beginPath();
          ctx.moveTo(currentPoints[i].x, currentPoints[i].y);
          ctx.lineTo(currentPoints[j].x, currentPoints[j].y);
          ctx.stroke();
        }
      }
    }

    // Highlight ROI Regions (Cheeks & Forehead)
    const roiPoints = [currentPoints[0], currentPoints[15], currentPoints[18]];
    roiPoints.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6 + Math.sin(t * 2) * 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 180, 216, 0.6)';
      ctx.fill();
      ctx.strokeStyle = '#00B4D8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Draw all landmark points
    currentPoints.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    });

    frame++;
    requestAnimationFrame(renderMesh);
  }

  renderMesh();

  // Dynamic Live Vitals Ticker in Hero Card
  setInterval(() => {
    const hrEl = document.getElementById('simHR');
    const spo2El = document.getElementById('simSpO2');
    const bpEl = document.getElementById('simBP');
    const stressEl = document.getElementById('simStress');

    if (hrEl) hrEl.textContent = (72 + Math.floor(Math.sin(Date.now() / 2000) * 3));
    if (spo2El) spo2El.textContent = (98 + Math.floor(Math.random() * 2));
    if (bpEl) bpEl.textContent = `118/${78 + Math.floor(Math.random() * 3)}`;
    if (stressEl) stressEl.textContent = 'Normal (28)';
  }, 1800);
}

/* ==========================================================================
   5. Indicator Tabs Filtering
   ========================================================================== */
function initIndicatorTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const items = document.querySelectorAll('.indicator-item');
  if (!tabs.length || !items.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const category = tab.getAttribute('data-category');
      items.forEach(item => {
        const itemCat = item.getAttribute('data-category');
        if (category === 'all' || itemCat === category) {
          item.style.display = 'block';
        } else {
          item.style.display = 'none';
        }
      });
    });
  });
}

/* ==========================================================================
   6. HubSpot Form Validation & Real-time Feedback
   ========================================================================== */
function initHubSpotForm() {
  const form = document.getElementById('hubspotLeadForm');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const email = document.getElementById('hsEmail')?.value.trim();
    const name = document.getElementById('hsName')?.value.trim();
    const btn = form.querySelector('button[type="submit"]');

    if (!email || !name) {
      alert('Please fill in all required enterprise contact details.');
      return;
    }

    // Enterprise CRM submission feedback simulation
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Processing Request...';

    setTimeout(() => {
      form.innerHTML = `
        <div style="text-align: center; padding: 2.5rem 1rem;">
          <div style="font-size: 3rem; color: #10B981; margin-bottom: 1rem;">
            <i class="fa fa-check-circle" aria-hidden="true"></i>
          </div>
          <h3 style="font-size: 1.5rem; margin-bottom: 0.5rem; color: #1D3557;">Demo Request Received!</h3>
          <p style="color: #6C757D; font-size: 0.95rem;">A Binah.ai enterprise solutions architect will contact you within 24 hours.</p>
        </div>
      `;
    }, 1200);
  });
}

/* ==========================================================================
   7. Complianz GDPR Cookie Consent Manager
   ========================================================================== */
function initCookieConsent() {
  const banner = document.getElementById('complianzCookieBanner');
  const acceptBtn = document.getElementById('cmplzAccept');
  const denyBtn = document.getElementById('cmplzDeny');
  if (!banner || !acceptBtn) return;

  const consent = localStorage.getItem('cmplz_consent_status');
  if (!consent) {
    setTimeout(() => {
      banner.classList.add('active');
    }, 1000);
  }

  acceptBtn.addEventListener('click', () => {
    localStorage.setItem('cmplz_consent_status', 'accepted');
    banner.classList.remove('active');
  });

  if (denyBtn) {
    denyBtn.addEventListener('click', () => {
      localStorage.setItem('cmplz_consent_status', 'denied');
      banner.classList.remove('active');
    });
  }
}

/* ==========================================================================
   8. Smooth Scroll Navigation
   ========================================================================== */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#') return;
      const targetEl = document.querySelector(targetId);
      if (targetEl) {
        e.preventDefault();
        const headerOffset = 80;
        const elementPosition = targetEl.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      }
    });
  });
}
