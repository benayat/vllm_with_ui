export function renderResultJson(result) {
    const resultBox = document.getElementById('resultBox');
    if (!resultBox) return;
    resultBox.textContent = result ? JSON.stringify(result, null, 2) : '';
}
