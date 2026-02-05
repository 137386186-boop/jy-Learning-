export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export const getHealthUrl = (): string => {
  if (API_BASE.startsWith('http')) {
    const base = API_BASE.endsWith('/api') ? API_BASE.slice(0, -4) : API_BASE;
    return `${base}/health`;
  }
  return `${API_BASE}/health`;
};
