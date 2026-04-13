export function setSummaryCards(elId, items) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '';
    const safeItems = Array.isArray(items) ? items.filter((it) => it && it.k) : [];
    if (!safeItems.length) return;
    for (const item of safeItems) {
        const card = document.createElement('div');
        card.className = 'summary-card';
        const k = document.createElement('span');
        k.className = 'summary-k';
        k.textContent = item.k;
        const v = document.createElement('span');
        v.className = 'summary-v';
        v.textContent = item.v ?? '—';
        card.appendChild(k);
        card.appendChild(v);
        el.appendChild(card);
    }
}
