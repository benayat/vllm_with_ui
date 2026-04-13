export function formatJsonParseError(rawMessage, rawValue) {
    const msg = String(rawMessage || 'Invalid JSON');
    const match = msg.match(/position\s+(\d+)/i);
    if (!match) return msg;
    const pos = Number(match[1]);
    if (!Number.isFinite(pos) || pos < 0) return msg;
    const text = rawValue || '';
    const line = text.slice(0, pos).split('\n').length;
    const col = pos - text.lastIndexOf('\n', pos - 1);
    return `${msg} (line ${line}, column ${col})`;
}

export function validateJsonField({ inputId, statusId, optional = false, expectArray = false, key, itemValidator = null, itemError = 'Invalid item shape.', setFieldStatus, setValidationFlag }) {
    const rawValue = document.getElementById(inputId)?.value || '';
    const value = rawValue.trim();
    if (!value) {
        if (optional) {
            setFieldStatus(statusId, 'muted', 'Optional.');
            setValidationFlag(key, true);
            return true;
        }
        setFieldStatus(statusId, 'warn', 'Required field is empty.');
        setValidationFlag(key, false);
        return false;
    }

    try {
        const parsed = JSON.parse(value);
        if (expectArray && !Array.isArray(parsed)) {
            setFieldStatus(statusId, 'err', 'Must be a JSON array.');
            setValidationFlag(key, false);
            return false;
        }
        if (expectArray && itemValidator && !parsed.every(itemValidator)) {
            setFieldStatus(statusId, 'err', itemError);
            setValidationFlag(key, false);
            return false;
        }
        setFieldStatus(statusId, 'ok', 'Valid JSON.');
        setValidationFlag(key, true);
        return true;
    } catch (err) {
        setFieldStatus(statusId, 'err', formatJsonParseError(err.message, rawValue));
        setValidationFlag(key, false);
        return false;
    }
}

export async function validateUploadInput({ inputId, statusId, key, expectArray = true, itemValidator = null, itemError = 'Invalid item shape.', setFieldStatus, setValidationFlag }) {
    const fileEl = document.getElementById(inputId);
    const file = fileEl?.files && fileEl.files[0];
    if (!file) {
        setFieldStatus(statusId, 'muted', 'No file selected.');
        setValidationFlag(key, true);
        return true;
    }
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (expectArray && !Array.isArray(parsed)) {
            setFieldStatus(statusId, 'err', 'Uploaded JSON must be an array.');
            setValidationFlag(key, false);
            return false;
        }
        if (expectArray && itemValidator && !parsed.every(itemValidator)) {
            setFieldStatus(statusId, 'err', itemError);
            setValidationFlag(key, false);
            return false;
        }
        setFieldStatus(statusId, 'ok', `Loaded ${file.name}`);
        setValidationFlag(key, true);
        return true;
    } catch (err) {
        setFieldStatus(statusId, 'err', formatJsonParseError(err.message, ''));
        setValidationFlag(key, false);
        return false;
    }
}
