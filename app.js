const PRICE_REPOSITORY = 'frostcutter778/raleigh-711-prices';

const GRADES = [
  ['regular', 'Regular'],
  ['midgrade', 'Mid-grade'],
  ['premium', 'Premium'],
  ['diesel', 'Diesel'],
  ['kerosene', 'Kerosene'],
];
const GRADE_LABEL = Object.fromEntries(GRADES);
const PALETTE = ['#f0b429', '#3ddc84', '#7eb6ff', '#ff8b6a', '#d7a4ff', '#6aebff', '#ffd36a', '#ff6b9a'];
const NY = 'America/New_York';

const state = {
  board: null,
  history: null,
  grade: 'regular',
  brand: 'all',
  range: '24h',
  bucket: 'hour',
  sortKey: 'regular',
  sortDir: 'asc',
  pinnedId: null,
  hidden: new Set(),
  seenPrices: new Map(),
  seenSuccess: null,
  drawnWidth: 0,
};

const hero = document.querySelector('#hero');
const bars = document.querySelector('#bars');
const scaleNote = document.querySelector('#scale-note');
const tbody = document.querySelector('#board-body');
const historyNote = document.querySelector('#history-note');
const chartBox = document.querySelector('#chart');
const legend = document.querySelector('#legend');
const changesBox = document.querySelector('#changes');
const statusLine = document.querySelector('#status-line');
const checkButton = document.querySelector('#check-now');
const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
tooltip.hidden = true;
document.body.append(tooltip);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function mills(value) {
  return value == null ? null : Math.round(value * 1000);
}

function money(value) {
  return value == null ? '—' : `$${value.toFixed(3)}`;
}

function deltaText(next, prev) {
  if (next == null || prev == null || mills(next) === mills(prev)) return '';
  const rounded = (mills(next) - mills(prev)) / 1000;
  const sign = rounded > 0 ? '+' : '−';
  return `${sign}${Math.abs(rounded).toFixed(3)}`;
}

function brandLabel(slug) {
  if (slug === '7-eleven') return '7-Eleven';
  if (slug === 'speedway') return 'Speedway';
  return slug || 'Station';
}

function ago(iso) {
  if (!iso) return 'unknown';
  const delta = new Date(iso).getTime() - Date.now();
  const future = delta > 0;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return future ? 'in under a minute' : 'just now';
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const body = minutes < 60
    ? `${minutes} min`
    : hours < 36
      ? `${hours} hr`
      : `${days} day${days === 1 ? '' : 's'}`;
  return future ? `in ${body}` : `${body} ago`;
}

function clock(iso, withDate) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    month: withDate ? 'short' : undefined,
    day: withDate ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function visibleStations() {
  const stations = state.board?.stations || [];
  return stations.filter((station) => state.brand === 'all' || station.brand === state.brand);
}

function colorFor(id) {
  const ids = [...(state.board?.stations || [])].map((station) => station.id).sort();
  const index = Math.max(0, ids.indexOf(id));
  return PALETTE[index % PALETTE.length];
}

function renderStatus() {
  const status = state.board?.status;
  if (!status) {
    statusLine.textContent = 'Starting the first check…';
    return;
  }
  if (!status.lastSuccessAt && status.polling) {
    statusLine.textContent = 'Checking 7-Eleven for Raleigh fuel prices…';
    return;
  }
  const checked = status.lastSuccessAt ? `Last snapshot ${ago(status.lastSuccessAt)}.` : 'No snapshot yet.';
  const cadence = ' GitHub looks for a new posted price about every 5 minutes.';
  const problem = status.lastError ? ` Last check failed: ${status.lastError}.` : '';
  statusLine.textContent = `${checked}${cadence}${problem}`;
}

function renderHero(stations) {
  hero.replaceChildren();
  const grade = state.grade;
  const label = GRADE_LABEL[grade];
  const priced = stations.filter((station) => station.prices[grade] != null);
  const priceCard = el('div', { class: 'hero-card' });
  const spreadCard = el('div', { class: 'hero-card spread' });

  if (!state.board) {
    priceCard.append(el('p', {}, 'Waiting for the first reading from 7-Eleven.'));
    hero.append(priceCard);
    return;
  }
  if (!priced.length) {
    priceCard.append(
      el('p', { class: 'kicker' }, label),
      el('p', {}, `None of the stations in this view posted a ${label.toLowerCase()} price.`),
    );
    hero.append(priceCard);
    return;
  }

  const lowest = Math.min(...priced.map((station) => mills(station.prices[grade])));
  const highest = Math.max(...priced.map((station) => mills(station.prices[grade])));
  const leaders = priced.filter((station) => mills(station.prices[grade]) === lowest);
  const leaderPrice = leaders[0].prices[grade];
  const names = leaders.map((station) => station.address);
  const where = names.length === 1
    ? `${names[0]} · ${brandLabel(leaders[0].brand)}`
    : names.length === 2
      ? `Tied between ${names[0]} and ${names[1]}`
      : `Tied across ${names.length} stations`;

  priceCard.append(
    el('p', { class: 'kicker' }, `Cheapest ${label.toLowerCase()}`),
    el('p', { class: 'hero-price' }, money(leaderPrice)),
    el('p', {}, where),
  );

  const spread = (highest - lowest) / 1000;
  const tracked = state.board.status.trackingSince
    ? `Tracking since ${clock(state.board.status.trackingSince, true)}.`
    : 'The first reading is in.';
  spreadCard.append(
    el('p', { class: 'kicker' }, `${label} spread`),
    el('p', { class: 'hero-price' }, money(spread).replace('$', '$')),
    el('p', {}, priced.length < 2
      ? 'One station posted this grade.'
      : spread === 0
        ? `Every station in this view is posted at the same ${label.toLowerCase()} price. ${tracked}`
        : `${money(spread)} from the lowest to the highest ${label.toLowerCase()} price among ${priced.length} stations. ${tracked}`),
  );
  hero.append(priceCard, spreadCard);
}

function renderBars(stations) {
  bars.replaceChildren();
  const grade = state.grade;
  const priced = stations
    .filter((station) => station.prices[grade] != null)
    .sort((a, b) => mills(a.prices[grade]) - mills(b.prices[grade]));
  if (priced.length < 2) {
    scaleNote.textContent = '';
    return;
  }
  const values = priced.map((station) => station.prices[grade]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(0.015, (max - min) * 0.15);
  const lo = min - pad;
  const hi = max + pad;
  const lowest = mills(min);
  scaleNote.textContent = 'The bars are zoomed in around the current prices. The scale does not start at $0.';
  for (const station of priced) {
    const width = ((station.prices[grade] - lo) / (hi - lo)) * 100;
    const isLow = mills(station.prices[grade]) === lowest;
    const row = el('div', { class: isLow ? 'bar-row is-low' : 'bar-row' }, [
      el('div', { class: 'bar-name' }, [
        el('strong', {}, station.address),
        el('span', { class: 'sub' }, brandLabel(station.brand)),
      ]),
      el('div', { class: 'track', 'aria-hidden': 'true' }, [
        el('span', { style: `width:${width}%` }),
      ]),
      el('div', { class: 'bar-price' }, money(station.prices[grade])),
    ]);
    bars.append(row);
  }
}

function priceStack(station, grade, lowest) {
  const value = station.prices[grade];
  const prior = station.previous[grade];
  const children = [el('span', { class: 'price' }, money(value))];
  if (value != null && prior && mills(prior.price) !== mills(value)) {
    const direction = mills(value) < mills(prior.price) ? 'down' : 'up';
    const change = el('span', {
      class: `delta ${direction}`,
      title: `Previous posted price ${money(prior.price)} at ${clock(prior.at, true)}`,
    }, deltaText(value, prior.price));
    children.push(change);
  }
  if (value != null && mills(value) === lowest) children.push(el('span', { class: 'low-tag' }, 'LOW'));
  return children;
}

function renderTable(stations) {
  const gradeValues = stations.map((station) => station.prices[state.grade]).filter((value) => value != null);
  const lowest = gradeValues.length ? Math.min(...gradeValues.map(mills)) : null;
  const showKerosene = stations.some((station) => station.prices.kerosene != null);
  document.querySelector('#board').classList.toggle('hide-kerosene', !showKerosene);
  const sorted = [...stations].sort((a, b) => compareStations(a, b));
  tbody.replaceChildren();
  document.querySelectorAll('#board th').forEach((th) => {
    const key = th.querySelector('button')?.dataset.sort;
    th.setAttribute('aria-sort', key === state.sortKey ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

    if (!sorted.length) {
    tbody.append(el('tr', {}, [
      el('td', { colspan: '7' }, state.board ? 'No stations match this brand.' : 'Checking 7-Eleven…'),
    ]));
    return;
  }

  for (const station of sorted) {
    const changed = state.seenPrices.has(station.id)
      && GRADES.some(([grade]) => mills(state.seenPrices.get(station.id)[grade]) !== mills(station.prices[grade]));
    const row = el('tr', { class: [station.id === state.pinnedId ? 'is-pinned' : '', changed ? 'flash' : '', mills(station.prices[state.grade]) === lowest ? 'is-low' : ''].filter(Boolean).join(' ') || null });
    row.addEventListener('click', () => {
      state.pinnedId = state.pinnedId === station.id ? null : station.id;
      render();
      drawChart();
    });

    const identity = el('div', { class: 'station-cell' }, [
      el('span', { class: `brand ${station.brand === '7-eleven' ? 'seven' : 'speedway'}` }, brandLabel(station.brand)),
      el('strong', {}, station.address),
      station.distanceLabel ? el('span', { class: 'meta' }, `${station.distanceLabel} from downtown`) : null,
      el('span', { class: 'links' }, [
        station.url ? el('a', { href: station.url, target: '_blank', rel: 'noreferrer' }, 'Store page') : null,
        el('a', { href: station.mapsUrl, target: '_blank', rel: 'noreferrer' }, 'Map'),
        station.phone ? el('a', { href: `tel:${station.phone.replace(/\D/g, '')}` }, station.phone) : null,
      ]),
    ]);
    identity.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => event.stopPropagation()));

    row.append(el('td', {}, identity));
    for (const [grade] of GRADES) {
      const classes = [
        grade === 'kerosene' ? 'kerosene' : '',
        mills(station.prices[grade]) === lowest && grade === state.grade ? 'cheapest' : '',
      ].filter(Boolean).join(' ');
      row.append(el('td', { class: classes || null }, priceStack(station, grade, grade === state.grade ? lowest : null)));
    }
    row.append(el('td', {}, [
      el('span', {}, station.priceUpdatedAt ? ago(station.priceUpdatedAt) : '—'),
      station.priceUpdatedAt ? el('span', { class: 'delta' }, clock(station.priceUpdatedAt, true)) : null,
    ]));
    tbody.append(row);
  }
}

function compareStations(a, b) {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  if (state.sortKey === 'address') return a.address.localeCompare(b.address) * dir;
  if (state.sortKey === 'updated') {
    const at = new Date(a.priceUpdatedAt || 0).getTime();
    const bt = new Date(b.priceUpdatedAt || 0).getTime();
    return (at - bt) * dir;
  }
  const av = a.prices[state.sortKey];
  const bv = b.prices[state.sortKey];
  if (av == null && bv == null) return a.address.localeCompare(b.address);
  if (av == null) return 1;
  if (bv == null) return -1;
  const diff = mills(av) - mills(bv);
  return diff === 0 ? a.address.localeCompare(b.address) : diff * dir;
}

function renderChanges() {
  const changes = state.board?.changes || [];
  changesBox.replaceChildren();
  if (!changes.length) {
    changesBox.append(el('p', { class: 'empty' }, 'No posted price has changed since tracking started. The first check only records the current board. The next change shows up here after GitHub’s next check, about every 5 minutes.'));
    return;
  }
  for (const change of changes) {
    const direction = mills(change.newPrice) < mills(change.oldPrice) ? 'down' : 'up';
    changesBox.append(el('article', { class: 'change' }, [
      el('div', {}, [
        el('strong', {}, change.address),
        ` · ${brandLabel(change.brand)}`,
      ]),
      el('div', {}, [
        `${GRADE_LABEL[change.grade] || change.grade} `,
        el('strong', {}, money(change.oldPrice)),
        ' → ',
        el('strong', { class: `delta ${direction}` }, money(change.newPrice)),
        ` (${deltaText(change.newPrice, change.oldPrice)})`,
      ]),
      el('div', { class: 'meta' }, `Noticed ${ago(change.detectedAt)} · board time ${clock(change.priceUpdatedAt || change.detectedAt, true)}`),
    ]));
  }
}

function render() {
  const stations = visibleStations();
  renderStatus();
  renderHero(stations);
  renderBars(stations);
  renderTable(stations);
  renderChanges();
  renderLegend(stations);
  if (state.board) {
    for (const station of state.board.stations) state.seenPrices.set(station.id, { ...station.prices });
  }
}

function historySentence() {
  const series = (state.history?.series || []).filter((item) => matchesBrand(item) && !state.hidden.has(item.id));
  const points = series.reduce((sum, item) => sum + item.points.length, 0);
  const label = GRADE_LABEL[state.grade].toLowerCase();
  const span = state.range === '24h' ? '24 hours' : state.range === '7d' ? '7 days' : '30 days';
  const step = state.bucket === 'day' ? 'Daily' : state.bucket === 'hour' ? 'Hourly' : 'Every saved reading of';
  if (!state.history) return 'Loading the saved history…';
  if (!points) return `No ${label} readings in the last ${span} yet.`;
  const richest = Math.max(...series.map((item) => item.points.length));
  if (richest < 2) {
    return `${step} ${label} over the last ${span}. There is only one saved reading per station so far. A new point is saved when a posted price changes, and at least once an hour.`;
  }
  return `${step} ${label} over the last ${span}, Eastern time. A gap in a line means no snapshot was saved then. The last posted price in each ${state.bucket === 'day' ? 'day' : 'hour'} is kept when the view is rolled up.`;
}

function matchesBrand(item) {
  return state.brand === 'all' || item.brand === state.brand;
}

function renderLegend(stations) {
  legend.replaceChildren();
  for (const station of stations) {
    const button = el('button', {
      type: 'button',
      class: state.hidden.has(station.id) ? 'is-off' : '',
      'aria-pressed': String(!state.hidden.has(station.id)),
    }, [
      el('span', { class: 'swatch', style: `background:${colorFor(station.id)}` }),
      station.address.replace(', Raleigh', ''),
    ]);
    button.addEventListener('click', () => {
      if (state.hidden.has(station.id)) state.hidden.delete(station.id);
      else state.hidden.add(station.id);
      renderLegend(visibleStations());
      drawChart();
    });
    legend.append(button);
  }
}

function niceStep(span) {
  if (span <= 0.05) return 0.01;
  if (span <= 0.2) return 0.02;
  if (span <= 0.5) return 0.05;
  if (span <= 1.5) return 0.1;
  return 0.25;
}

function drawChart() {
  const width = chartBox.clientWidth;
  if (!width) return;
  state.drawnWidth = width;
  historyNote.textContent = historySentence();
  chartBox.replaceChildren();
  tooltip.hidden = true;
  const height = 360;
  const pad = { top: 16, right: 16, bottom: 36, left: 72 };
  const series = (state.history?.series || [])
    .filter((item) => matchesBrand(item) && !state.hidden.has(item.id) && item.points.length)
    .map((item) => ({ ...item, points: item.points.filter((point) => point.price != null) }))
    .filter((item) => item.points.length);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', historySentence());

  if (!series.length) {
    chartBox.append(svg);
    return;
  }

  const all = series.flatMap((item) => item.points);
  const prices = all.map((point) => point.price);
  const times = all.map((point) => new Date(point.t).getTime());
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) {
    min -= 0.02;
    max += 0.02;
  } else {
    const padPrice = (max - min) * 0.12;
    min -= padPrice;
    max += padPrice;
  }
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xFor = (t) => pad.left + ((t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * plotW);
  const yFor = (price) => pad.top + ((max - price) / (max - min)) * plotH;
  const gapMs = state.bucket === 'day' ? 36 * 3600 * 1000 : 90 * 60 * 1000;

  const step = niceStep(max - min);
  const startTick = Math.ceil(min / step) * step;
  for (let tick = startTick; tick <= max + step / 10; tick += step) {
    const y = yFor(tick);
    const grid = document.createElementNS(svg.namespaceURI, 'line');
    grid.setAttribute('x1', pad.left);
    grid.setAttribute('x2', width - pad.right);
    grid.setAttribute('y1', y);
    grid.setAttribute('y2', y);
    grid.setAttribute('stroke', '#2c3830');
    svg.append(grid);
    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', pad.left - 8);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', '#93a399');
    label.setAttribute('font-size', '12');
    label.textContent = `$${tick.toFixed(step < 0.1 ? 3 : 2)}`;
    svg.append(label);
  }

  const tickCount = t1 === t0 ? 1 : Math.min(6, all.length);
  for (let i = 0; i < tickCount; i += 1) {
    const t = tickCount === 1 ? t0 : t0 + ((t1 - t0) * i) / (tickCount - 1);
    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', xFor(t));
    label.setAttribute('y', height - 12);
    label.setAttribute('text-anchor', tickCount === 1 ? 'middle' : i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle');
    label.setAttribute('fill', '#93a399');
    label.setAttribute('font-size', '12');
    const spanDays = (t1 - t0) / 86400000;
    label.textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: NY,
      month: spanDays > 1 ? 'short' : undefined,
      day: spanDays > 1 ? 'numeric' : undefined,
      hour: spanDays > 2 ? undefined : 'numeric',
      minute: spanDays > 2 ? undefined : '2-digit',
    }).format(new Date(t));
    svg.append(label);
  }

  const hitPoints = [];
  series.forEach((item, seriesIndex) => {
    const faded = state.pinnedId && state.pinnedId !== item.id;
    const color = colorFor(item.id);
    let segment = [];
    const flush = () => {
      if (segment.length < 2) {
        segment = [];
        return;
      }
      const path = document.createElementNS(svg.namespaceURI, 'polyline');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', faded ? '1.5' : '2.5');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('opacity', faded ? '0.25' : '1');
      path.setAttribute('points', segment.map((point) => `${xFor(new Date(point.t).getTime())},${yFor(point.price)}`).join(' '));
      svg.append(path);
      segment = [];
    };
    item.points.forEach((point, index) => {
      if (index > 0) {
        const gap = new Date(point.t) - new Date(item.points[index - 1].t);
        if (gap > gapMs) flush();
      }
      segment.push(point);
    });
    flush();
    for (const point of item.points) {
      const circle = document.createElementNS(svg.namespaceURI, 'circle');
      const sameInstant = t1 === t0 ? (seriesIndex - (series.length - 1) / 2) * 18 : 0;
      const x = xFor(new Date(point.t).getTime()) + sameInstant;
      const y = yFor(point.price);
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r', item.points.length > 40 ? '2.5' : '4');
      circle.setAttribute('fill', color);
      circle.setAttribute('opacity', faded ? '0.25' : '1');
      svg.append(circle);
      hitPoints.push({ x, y, address: item.address, price: point.price, t: point.t, color });
    }
  });

  svg.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const x = (event.clientX - rect.left) * scale;
    let nearest = null;
    for (const point of hitPoints) {
      const distance = Math.abs(point.x - x);
      if (!nearest || distance < nearest.distance) nearest = { ...point, distance };
    }
    if (!nearest || nearest.distance > 28) {
      tooltip.hidden = true;
      return;
    }
    const sameTime = hitPoints.filter((point) => Math.abs(point.x - nearest.x) < 8);
    tooltip.replaceChildren();
    tooltip.append(el('div', { class: 'meta' }, clock(nearest.t, true)));
    for (const point of sameTime) {
      tooltip.append(el('div', {}, `${point.address}: ${money(point.price)}`));
    }
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 280)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
  });
  svg.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  chartBox.append(svg);
}

function dataUrl() {
  const host = location.hostname;
  const published = host.endsWith('github.io')
    ? `https://raw.githubusercontent.com/${PRICE_REPOSITORY}/data/prices.json`
    : 'data/prices.json';
  return `${published}?t=${Date.now()}`;
}

function hourKey(date) {
  const parts = nyParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function dayKey(date) {
  const parts = nyParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nyParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

function bucketPoints(points, bucket) {
  const kept = points.filter((point) => point.price != null);
  if (bucket === 'reading') return kept;
  const grouped = [];
  let key = null;
  let current = null;
  for (const point of kept) {
    const nextKey = bucket === 'day' ? dayKey(new Date(point.t)) : hourKey(new Date(point.t));
    if (nextKey !== key) {
      if (current) grouped.push(current);
      key = nextKey;
      current = point;
    } else {
      current = point;
    }
  }
  if (current) grouped.push(current);
  return grouped;
}

function previousDifferent(readings, storeId, grade, current) {
  if (current == null) return null;
  const currentMills = mills(current);
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    if (reading.storeId !== storeId || reading[grade] == null) continue;
    if (mills(reading[grade]) === currentMills) continue;
    return { price: reading[grade], at: reading.priceUpdatedAt || reading.observedAt };
  }
  return null;
}

function buildBoard(data) {
  const readings = data.readings || [];
  const latest = new Map();
  for (const reading of readings) latest.set(reading.storeId, reading);
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const stations = Object.values(data.stations || {})
    .filter((station) => station.lastSeenAt && new Date(station.lastSeenAt).getTime() >= cutoff)
    .map((station) => {
      const reading = latest.get(station.id);
      const prices = {};
      const previous = {};
      for (const [grade] of GRADES) {
        prices[grade] = reading ? reading[grade] ?? null : null;
        previous[grade] = previousDifferent(readings, station.id, grade, prices[grade]);
      }
      return {
        ...station,
        prices,
        previous,
        priceUpdatedAt: reading?.priceUpdatedAt || null,
        observedAt: reading?.observedAt || null,
      };
    });
  return {
    status: {
      lastSuccessAt: data.generatedAt,
      lastError: data.lastError,
      intervalMs: (data.intervalMinutes || 5) * 60 * 1000,
      trackingSince: readings[0]?.observedAt || data.generatedAt,
      stationCount: stations.length,
      readings: readings.length,
    },
    stations,
    changes: [...(data.changes || [])].reverse().slice(0, 40).map((change) => ({
      ...change,
      address: data.stations?.[change.storeId]?.address || '',
      brand: data.stations?.[change.storeId]?.brand || '',
    })),
  };
}

function buildHistory() {
  const readings = state.raw?.readings || [];
  const days = state.range === '30d' ? 30 : state.range === '7d' ? 7 : 1;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const byStore = new Map();
  for (const reading of readings) {
    if (new Date(reading.observedAt).getTime() < since) continue;
    if (!byStore.has(reading.storeId)) byStore.set(reading.storeId, []);
    byStore.get(reading.storeId).push({ t: reading.observedAt, price: reading[state.grade] ?? null });
  }
  state.history = {
    range: state.range,
    bucket: state.bucket,
    grade: state.grade,
    series: [...byStore.entries()].map(([id, points]) => ({
      id,
      address: state.raw.stations?.[id]?.address || id,
      brand: state.raw.stations?.[id]?.brand || '',
      points: bucketPoints(points, state.bucket),
    })),
  };
}

async function loadHistory() {
  if (!state.raw) return;
  buildHistory();
  drawChart();
}

async function loadBoard() {
  const response = await fetch(dataUrl());
  if (!response.ok) throw new Error('Price data is not available yet');
  const data = await response.json();
  const signature = JSON.stringify({ generatedAt: data.generatedAt, error: data.lastError, readings: data.readings?.length, changes: data.changes?.length });
  state.raw = data;
  const changed = signature !== state.boardSignature;
  state.boardSignature = signature;
  state.board = buildBoard(data);
  if (changed) {
    render();
    await loadHistory();
  } else {
    renderStatus();
  }
}

function bindSegments(selector, key) {
  document.querySelectorAll(selector).forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.grade || button.dataset.brand || button.dataset.range || button.dataset.bucket;
      state[key] = value;
      button.parentElement.querySelectorAll('button').forEach((peer) => {
        peer.setAttribute('aria-pressed', String(peer === button));
      });
      if (key === 'grade') {
        state.sortKey = value;
        state.sortDir = 'asc';
      }
      if (key === 'range') {
        const bucket = value === '30d' ? 'day' : 'hour';
        state.bucket = bucket;
        document.querySelectorAll('[data-bucket]').forEach((peer) => {
          peer.setAttribute('aria-pressed', String(peer.dataset.bucket === bucket));
        });
      }
      render();
      if (key === 'grade' || key === 'range' || key === 'bucket') await loadHistory();
      else drawChart();
    });
  });
}

document.querySelectorAll('#board th button').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.sort;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      state.sortKey = key;
      state.sortDir = key === 'address' || key === 'updated' ? 'asc' : 'asc';
    }
    renderTable(visibleStations());
  });
});

checkButton.addEventListener('click', async () => {
  checkButton.disabled = true;
  statusLine.textContent = 'Reloading the latest snapshot…';
  try {
    state.boardSignature = null;
    await loadBoard();
  } catch (error) {
    statusLine.textContent = `Reload failed: ${error.message}`;
  } finally {
    checkButton.disabled = false;
  }
});

bindSegments('[data-grade]', 'grade');
bindSegments('[data-brand]', 'brand');
bindSegments('[data-range]', 'range');
bindSegments('[data-bucket]', 'bucket');

new ResizeObserver(() => {
  if (Math.abs(chartBox.clientWidth - state.drawnWidth) > 2) drawChart();
}).observe(chartBox);

setInterval(renderStatus, 1000);

async function loop() {
  try {
    await loadBoard();
  } catch (error) {
    statusLine.textContent = `The price board is unavailable: ${error.message}`;
  }
  setTimeout(loop, state.board?.stations?.length ? 60000 : 2000);
}

loop();
