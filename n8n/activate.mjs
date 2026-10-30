import { api } from './lib.mjs';
for (const id of ['N8N_ID', 'N8N_ID', 'N8N_ID', 'N8N_ID']) {
  await api('POST', `/api/v1/workflows/${id}/activate`); const w = await api('GET', `/api/v1/workflows/${id}`); console.log(w.name, w.active);
}
