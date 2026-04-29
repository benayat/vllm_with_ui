export function renderActivityFeed(items) {
    const feed = document.getElementById('activityFeed');
    if (!feed) return;
    feed.innerHTML = '';
    for (const item of items) {
        const li = document.createElement('li');
        const ts = document.createElement('span');
        ts.className = 'activity-time';
        ts.textContent = `[${item.ts}]`;
        const msg = document.createElement('span');
        msg.className = item.kind;
        msg.textContent = item.message;
        li.appendChild(ts);
        li.appendChild(msg);
        feed.appendChild(li);
    }
}
