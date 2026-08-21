(function (root) {
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  let loader = null;

  function loadEngine() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (loader) return loader;
    loader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.crossOrigin = 'anonymous';
      script.onload = () => root.Tesseract ? resolve(root.Tesseract) : reject(new Error('OCR engine did not initialize'));
      script.onerror = () => reject(new Error('Could not load the OCR engine'));
      document.head.appendChild(script);
    });
    return loader;
  }

  function numericCandidates(text) {
    const values = String(text || '').match(/\b\d{1,3}(?:[,.]\d{3})+\b|\b\d{2,6}\b/g) || [];
    return [...new Set(values.map(value => Number(value.replace(/[,.]/g, '')))
      .filter(value => Number.isFinite(value) && value > 0 && value <= 100000))]
      .sort((a, b) => a - b);
  }

  async function recognize(image, logger) {
    const engine = await loadEngine();
    const result = await engine.recognize(image, 'eng', { logger });
    const text = result?.data?.text || '';
    return { text, candidates: numericCandidates(text) };
  }

  root.POE2GoldOCR = { recognize, numericCandidates };
})(window);
