/* Dashboard client. ES5 only: it has to run on iOS 9 Safari. */
(function () {
  'use strict';

  var POLL_MS = 30000;
  var RELOAD_AFTER_MS = 6 * 3600 * 1000;   // iPad mini 1 has 512 MB, so start clean now and then
  var WINDOW_H = 16, BACK_H = 1;
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                'September', 'October', 'November', 'December'];
  var NS = 'http://www.w3.org/2000/svg';

  var bootLogged = false, drew = null, state = null, lastOk = 0, bootAt = Date.now(), lastClock = '', lastAxisMin = -1;
  var searchTimer = null, driftStep = 0;
  var NO_DIM = /[?&]dim=0/.test(window.location.search);   // add ?dim=0 to the address to switch night dimming off

  var VERSION = 'v7', logged = 0;
  function clog(msg) {   // sent to the server so a problem on the iPad can be read from hpdesk2's journal
    if (logged++ > 40) return;
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/clientlog', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ v: VERSION, msg: String(msg).slice(0, 600), ua: navigator.userAgent }));
    } catch (e) { /* nothing more to do */ }
  }
  window.onerror = function (m, u, l, c) { clog('ERROR ' + m + ' @' + l + ':' + c); };

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(sec) { var d = new Date(sec * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function icon(name, cls) {
    return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use xlink:href="#i-' + name + '"/></svg>';
  }
  var clockOffset = 0;   // server time minus this device's time, so a drifting iPad clock cannot break anything
  function nowSec() { return Math.floor(Date.now() / 1000) + clockOffset; }
  function midnight(sec) { var d = new Date(sec * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); }

  /* ------------------------------------------------------------ weather */
  function wx(code, day) {
    var d = day !== 0;
    if (code === 0) return { i: d ? 'sun' : 'moon', t: d ? 'Clear' : 'Clear night' };
    if (code === 1) return { i: d ? 'sun' : 'moon', t: 'Mostly clear' };
    if (code === 2) return { i: d ? 'cloud-sun' : 'cloud-moon', t: 'Partly cloudy' };
    if (code === 3) return { i: 'cloud', t: 'Overcast' };
    if (code === 45 || code === 48) return { i: 'cloud-fog', t: 'Fog' };
    if (code >= 51 && code <= 57) return { i: 'cloud-rain', t: 'Drizzle' };
    if (code >= 61 && code <= 67) return { i: 'cloud-rain', t: code >= 65 ? 'Heavy rain' : 'Rain' };
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { i: 'cloud-snow', t: 'Snow' };
    if (code >= 80 && code <= 82) return { i: 'cloud-rain', t: 'Showers' };
    if (code >= 95) return { i: 'cloud-lightning', t: 'Thunderstorm' };
    return { i: 'cloud', t: 'Cloudy' };
  }

  /* -------------------------------------------------------------- clock */
  function tickClock() {
    var d = new Date(nowSec() * 1000);
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (t !== lastClock) {
      lastClock = t;
      $('time').textContent = t;
      $('date').textContent = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
      var h = d.getHours() + d.getMinutes() / 60;
      document.body.className = (!NO_DIM && (h >= 23 || h < 6.5)) ? 'night' : '';
      if (d.getMinutes() % 5 === 0) drift();
      renderAxis();
      renderPipeline();
      renderServers();     // keeps "last seen" and offline detection fresh
      renderAllDay();
    }
  }

  // Move the whole layout a few pixels now and then so nothing sits on the same LCD pixels all night.
  function drift() {
    var p = [[0, 0], [4, 2], [-3, 4], [-4, -2], [3, -3]][driftStep++ % 5];
    $('stage').style.webkitTransform = $('stage').style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)';
  }

  /* ------------------------------------------------------ current weather */
  function renderNow() {
    var w = state && state.weather;
    if (!w) {
      $('wx-icon').innerHTML = icon('cloud-slash');
      $('wx-temp').innerHTML = '--';
      $('wx-text').innerHTML = '<b>No weather yet</b><span class="place">' + (state ? 'Waiting for the server' : '') + '</span>';
      return;
    }
    var c = w.current, k = wx(c.code, c.day);
    var today = w.daily && w.daily[0], sun = '';
    if (today) {
      var n = nowSec();
      sun = n < today.sunrise ? 'Sunrise ' + hhmm(today.sunrise)
          : n < today.sunset ? 'Sunset ' + hhmm(today.sunset)
          : (w.daily[1] ? 'Sunrise ' + hhmm(w.daily[1].sunrise) : '');
    }
    $('wx-icon').innerHTML = icon(k.i);
    $('wx-temp').innerHTML = c.temp + '<sup>&deg;</sup>';
    $('wx-text').innerHTML = '<b>' + k.t + '</b>' +
      '<span>Feels like ' + c.feels + '&deg;, wind ' + c.wind + ' mph</span>' +
      (sun ? '<span>' + sun + (today ? ', high ' + today.max + '&deg;' : '') + '</span>' : '') +
      '<span class="place">' + icon('map-pin') + ' ' + esc(w.place) + '</span>';
  }

  /* ------------------------------------------------------------- all-day */
  function renderAllDay() {
    var el = $('allday');
    if (!state) { el.innerHTML = ''; return; }
    var n = nowSec(), m0 = midnight(n), html = '';
    for (var i = 0; i < state.events.length; i++) {
      var e = state.events[i];
      if (!e.allDay || e.end <= n || e.start >= m0 + 2 * 86400) continue;
      var tag = e.start >= m0 + 86400 ? 'Tomorrow' : e.end > m0 + 86400 && e.start < m0 ? 'Ongoing' : 'Today';
      html += '<span class="chip"><i>' + tag + '</i>' + esc(e.title) + '</span>';
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  /* ---------------------------------------------------------------- axis */
  function svgEl(name, attrs) {
    var el = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
    return el;
  }

  function renderAxis() {
    var host = $('axis-in');
    var W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) { clog('axis has no size ' + W + 'x' + H); return; }
    var n = nowSec();
    var start = n - BACK_H * 3600, span = WINDOW_H * 3600, end = start + span;
    var pps = W / span;
    function X(t) { return (t - start) * pps; }

    host.innerHTML = '';
    var w = state && state.weather;
    var PLOT = 172, LABEL_H = 22;              // plot = hour labels + weather
    var svg = svgEl('svg', { 'class': 'plot', width: W, height: PLOT });
    var i, hr, h;

    // night shading, from the hourly is_day flag
    if (w) {
      for (i = 0; i < w.hourly.length; i++) {
        h = w.hourly[i];
        if (h.day === 0 && h.t + 1800 > start && h.t - 1800 < end) {
          var x0 = Math.max(0, X(h.t - 1800)), x1 = Math.min(W, X(h.t + 1800));
          svg.appendChild(svgEl('rect', { 'class': 'nightband', x: x0, y: 0, width: x1 - x0, height: H }));
        }
      }
    }

    // hour grid + labels
    var first = Math.ceil(start / 3600) * 3600;
    for (var t = first; t < end; t += 3600) {
      var d = new Date(t * 1000), x = X(t), mid = d.getHours() === 0;
      svg.appendChild(svgEl('line', { 'class': 'hr-line', x1: x, y1: LABEL_H, x2: x, y2: H }));
      var lab = svgEl('text', { 'class': 'hr-lab' + (mid ? ' mid' : ''), x: x, y: 15 });
      lab.textContent = mid ? DAYS[d.getDay()].slice(0, 3) : pad(d.getHours());
      svg.appendChild(lab);
    }

    if (w) {
      var inWin = [];
      for (i = 0; i < w.hourly.length; i++) {
        h = w.hourly[i];
        if (h.t >= start - 3600 && h.t <= end + 3600) inWin.push(h);
      }
      var lo = 99, hi = -99;
      for (i = 0; i < inWin.length; i++) { lo = Math.min(lo, inWin[i].temp); hi = Math.max(hi, inWin[i].temp); }
      if (hi - lo < 5) { var c = (hi + lo) / 2; lo = c - 2.5; hi = c + 2.5; }
      var TY0 = 94, TY1 = 124;                   // temperature line band
      var Y = function (v) { return TY0 + (hi - v) / (hi - lo) * (TY1 - TY0); };

      // precipitation chance, bars grow up from the baseline
      for (i = 0; i < inWin.length; i++) {
        h = inWin[i];
        if (h.pop < 10) continue;
        var bh = Math.round(h.pop / 100 * 34) + 2, bx = X(h.t - 3600) + 2, bw = 3600 * pps - 4;
        svg.appendChild(svgEl('rect', { 'class': 'pop-bar', x: bx, y: PLOT - bh, width: bw, height: bh, rx: 2 }));
        if (h.pop >= 30) {
          var pl = svgEl('text', { 'class': 'pop-lab', x: bx + bw / 2, y: PLOT - bh - 4 });
          pl.textContent = h.pop + '%';
          svg.appendChild(pl);
        }
      }

      // temperature line
      var pts = [];
      for (i = 0; i < inWin.length; i++) pts.push(X(inWin[i].t).toFixed(1) + ',' + Y(inWin[i].temp).toFixed(1));
      if (pts.length > 1) svg.appendChild(svgEl('polyline', { 'class': 't-line', points: pts.join(' ') }));

      // icon + temperature every three hours, on the clock
      for (i = 0; i < inWin.length; i++) {
        h = inWin[i];
        var hour = new Date(h.t * 1000).getHours();
        if (hour % 3 !== 0 || h.t < start + 1200 || h.t > end - 1200) continue;
        var px = X(h.t), k = wx(h.code, h.day);
        var u = svgEl('use', { 'class': 'w-ico', x: px - 14, y: 28, width: 28, height: 28 });
        u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + k.i);
        svg.appendChild(u);
        svg.appendChild(svgEl('circle', { 'class': 't-dot', cx: px, cy: Y(h.temp), r: 4 }));
        var tl = svgEl('text', { 'class': 't-lab', x: px, y: Y(h.temp) - 11 });
        tl.textContent = Math.round(h.temp) + '°';
        svg.appendChild(tl);
      }
    }

    // now marker
    var nx = X(n);
    svg.appendChild(svgEl('line', { 'class': 'now-line', x1: nx, y1: LABEL_H - 4, x2: nx, y2: H }));
    svg.appendChild(svgEl('circle', { 'class': 'now-cap', cx: nx, cy: LABEL_H - 4, r: 5 }));
    host.appendChild(svg);

  }

  /* ------------------------------------------------------------ pipeline */
  var PIPE_GAP = 14, PIPE_VISIBLE = 4, pipeHtml = '';

  function relText(e, n) {
    if (e.start <= n) {
      var left = Math.round((e.end - n) / 60);
      return 'Now, ends in ' + (left >= 90 ? Math.round(left / 60) + ' h' : left + ' min');
    }
    var m = Math.round((e.start - n) / 60);
    if (m < 90) return 'In ' + m + ' min';
    if (m < 24 * 60) return 'In ' + Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return '';
  }

  function renderPipeline() {
    var host = $('pipe'), wrap = $('pipe-wrap');
    if (!state) return;
    var n = nowSec(), m0 = midnight(n), list = [], i, e;
    for (i = 0; i < state.events.length; i++) {
      e = state.events[i];
      if (!e.allDay && e.end > n) list.push(e);
    }
    var cw = Math.floor((host.clientWidth - (PIPE_VISIBLE - 1) * PIPE_GAP) / PIPE_VISIBLE) || 233;
    var html = '';
    for (i = 0; i < list.length; i++) {
      e = list[i];
      var d = new Date(e.start * 1000);
      var day = e.start < m0 + 86400 ? 'Today' : e.start < m0 + 2 * 86400 ? 'Tomorrow' : DAYS[d.getDay()] + ' ' + d.getDate();
      var ongoing = e.start <= n, rel = relText(e, n);
      html += '<div class="card' + (ongoing ? ' ongoing' : '') + (i === 0 ? ' first' : '') + (i === list.length - 1 ? ' last' : '') +
        '" style="width:' + cw + 'px"><div class="node"><i></i></div><div class="box">' +
        '<div class="c-day">' + day + '</div>' +
        '<div class="c-time">' + hhmm(e.start) + '<span>-' + hhmm(e.end) + '</span></div>' +
        '<div class="c-title">' + esc(e.title) + '</div>' +
        (rel ? '<div class="c-meta rel">' + rel + '</div>' : '') +
        (e.where ? '<div class="c-meta">' + icon('map-pin') + ' ' + esc(e.where) + '</div>' : '') +
        '</div></div>';
    }
    if (!list.length) {
      var msg = state.calendar && state.calendar.configured === false ? 'Add your Google Calendar link in config.json to see events here.'
              : state.calendar && state.calendar.error && !state.calendar.ok ? 'Calendar is not loading. The server will keep trying.'
              : 'Nothing coming up in the next two days.';
      html = '<div id="pipe-empty">' + msg + '</div>';
    }
    if (html !== pipeHtml) {
      var keep = host.scrollLeft;
      host.innerHTML = html;
      host.scrollLeft = keep;
      pipeHtml = html;
    }
    drew = { events: state.events.length, cards: list.length, cw: cw, W: host.clientWidth, H: host.clientHeight };
    updateMore();
  }

  // a fade on the right edge says there is more to swipe to
  function updateMore() {
    var host = $('pipe'), wrap = $('pipe-wrap');
    var more = host.scrollWidth - host.clientWidth - host.scrollLeft > 8;
    wrap.className = more ? 'more' : '';
  }

  /* ------------------------------------------------------------- servers */
  function fmtUp(s) {
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d > 0 ? d + 'd ' + h + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  function ago(sec) {
    var s = Math.max(0, nowSec() - sec);
    return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
  }
  function level(v, warm, hot) { return v >= hot ? 'hot' : v >= warm ? 'warm' : ''; }
  function meter(label, v, warm, hot) {
    if (v === undefined || v === null) return '<div class="meter"><label>' + label + '</label><div class="track"></div><b>--</b></div>';
    return '<div class="meter"><label>' + label + '</label><div class="track"><div class="fill ' + level(v, warm, hot) +
      '" style="width:' + Math.min(100, Math.round(v)) + '%"></div></div><b>' + Math.round(v) + '%</b></div>';
  }

  function renderServers() {
    var host = $('servers');
    if (!state) return;
    var html = '', n = nowSec();
    for (var i = 0; i < state.servers.length; i++) {
      var s = state.servers[i];
      // the server marks machines offline, but also stop trusting a stale page
      var online = s.online && (Date.now() - lastOk < 180000);
      var head = '<div class="srv-h"><span class="srv-n">' + esc(s.name) + '</span><span class="srv-st"><i></i>' +
                 (online ? 'Online' : 'Offline') + '</span></div><div class="srv-site">' + esc(s.site || '') + '</div>';
      if (!online) {
        html += '<div class="srv off">' + head + '<div class="srv-off-msg">' +
          (s.lastSeen ? 'No report' : 'Never reported') + '<span>' + (s.lastSeen ? 'Last seen ' + ago(s.lastSeen) : 'Agent not installed yet') + '</span></div></div>';
        continue;
      }
      var tcls = s.cpuTemp === undefined || s.cpuTemp === null ? 'none' : level(s.cpuTemp, 70, 85);
      var tv = tcls === 'none' ? '--' : Math.round(s.cpuTemp);
      html += '<div class="srv">' + head +
        '<div class="srv-m"><div class="temp ' + tcls + '">' + tv + '<sup>&deg;C</sup></div><div class="srv-kv">' +
        '<div><span>Uptime</span><b>' + fmtUp(s.uptime) + '</b></div>' +
        '<div><span>Load</span><b>' + (s.load1 !== undefined ? s.load1.toFixed(2) : '--') + '</b></div></div></div>' +
        meter('CPU', s.cpu, 75, 92) + meter('RAM', s.mem, 80, 92) + meter('Disk', s.disk, 85, 94) + '</div>';
    }
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  /* ---------------------------------------------------------------- data */
  function getJSON(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(), true);
    x.timeout = 10000;
    x.onload = function () {
      if (x.status >= 200 && x.status < 300) { try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); } }
      else cb(new Error('HTTP ' + x.status));
    };
    x.onerror = x.ontimeout = function () { cb(new Error('network')); };
    x.send();
  }
  function postJSON(url, body, cb) {
    var x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () { cb(x.status >= 200 && x.status < 300); };
    x.onerror = function () { cb(false); };
    x.send(JSON.stringify(body));
  }

  function poll() {
    getJSON('/api/state', function (err, data) {
      if (!err) {
        state = data; lastOk = Date.now();
        var off = data.now - Math.floor(Date.now() / 1000);
        clockOffset = Math.abs(off) > 5 ? off : 0;
        try { renderNow(); renderAllDay(); renderAxis(); renderPipeline(); renderServers(); }
        catch (e) { clog('RENDER ' + e + (e.stack ? ' ' + e.stack : '')); }
        if (!bootLogged) { bootLogged = true; clog('boot events=' + data.events.length + ' drew=' + JSON.stringify(drew) + ' offset=' + clockOffset + ' now=' + nowSec() + ' tz=' + new Date().getTimezoneOffset()); }
        if (Date.now() - bootAt > RELOAD_AFTER_MS) { window.location.reload(); return; }
      }
      renderBanner();
    });
  }

  function renderBanner() {
    var b = $('banner'), age = Date.now() - lastOk;
    if (lastOk && age < 90000) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = lastOk ? 'Cannot reach the dashboard server. Last update ' + Math.round(age / 60000) + ' min ago.'
                           : 'Cannot reach the dashboard server.';
  }

  /* ------------------------------------------------------ location sheet */
  function openSheet() {
    $('sheet').hidden = false;
    $('sheet-now').textContent = state && state.weather ? 'Showing ' + state.weather.place : '';
    $('results').innerHTML = '';
    $('q').value = '';
    setTimeout(function () { $('q').focus(); }, 50);
  }
  function closeSheet() { $('sheet').hidden = true; $('q').blur(); }

  function search() {
    var q = $('q').value.replace(/^\s+|\s+$/g, ''), ul = $('results');
    if (q.length < 2) { ul.innerHTML = ''; return; }
    ul.innerHTML = '<li class="msg">Searching...</li>';
    getJSON('/api/geocode?q=' + encodeURIComponent(q), function (err, d) {
      if (err || !d.results) { ul.innerHTML = '<li class="msg">Search failed. Check the connection.</li>'; return; }
      if (!d.results.length) { ul.innerHTML = '<li class="msg">No places found.</li>'; return; }
      var html = '';
      for (var i = 0; i < d.results.length; i++) {
        var r = d.results[i];
        html += '<li data-i="' + i + '">' + esc(r.name) + '</li>';
      }
      ul.innerHTML = html;
      ul._results = d.results;
    });
  }

  function pick(ev) {
    var li = ev.target;
    while (li && li.nodeName !== 'LI') li = li.parentNode;
    var ul = $('results');
    if (!li || li.className === 'msg' || !ul._results) return;
    var r = ul._results[parseInt(li.getAttribute('data-i'), 10)];
    postJSON('/api/location', r, function (ok) {
      closeSheet();
      if (ok) { setTimeout(poll, 2500); setTimeout(poll, 6000); }
    });
  }

  /* ---------------------------------------------------------------- boot */
  $('wx-now').addEventListener('click', openSheet);
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet(); });
  $('results').addEventListener('click', pick);
  $('q').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(search, 400); });

  tickClock();
  poll();
  setInterval(tickClock, 5000);
  setInterval(poll, POLL_MS);
  setInterval(renderBanner, 15000);
  window.addEventListener('resize', function () { renderAxis(); renderPipeline(); });
  $('pipe').addEventListener('scroll', updateMore);
})();
