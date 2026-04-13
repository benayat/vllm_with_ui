function emit(level, message, context = {}) {
    const payload = {
        ts: new Date().toISOString(),
        level,
        message,
        context,
    };
    if (level === 'error') console.error('[ui]', payload);
    else if (level === 'warn') console.warn('[ui]', payload);
    else console.log('[ui]', payload);
}

export const logger = {
    info(message, context) {
        emit('info', message, context);
    },
    warn(message, context) {
        emit('warn', message, context);
    },
    error(message, context) {
        emit('error', message, context);
    },
};
