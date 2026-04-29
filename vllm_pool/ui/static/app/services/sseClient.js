export function openTailSse(url, { onTail, onError } = {}) {
    const source = new EventSource(url);
    if (onTail) {
        source.addEventListener('tail', (ev) => {
            try {
                const obj = JSON.parse(ev.data);
                onTail(obj);
            } catch (err) {
                if (onError) onError(err);
            }
        });
    }
    if (onError) source.addEventListener('error', onError);
    return source;
}

export function closeSse(source) {
    if (!source) return;
    try {
        source.close();
    } catch (_) {
        // ignore close errors
    }
}
