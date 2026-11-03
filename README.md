# Radar Republicano

Acompanhamento ao vivo das intercalares dos EUA (3/11/2026), condado a condado, do ponto de vista republicano.
Site: https://radar-republicano.vercel.app (ensaio com números fictícios: `/?demo=0.5`).

- `api/state.js`: recolhe os ficheiros de resultados do NYT (contagens e projeções da AP), calcula o radar e responde com cache de 8 s na CDN.
- `api/tick.js` + `.github/workflows/noite-eleitoral.yml`: deteção de projeções/viragens e notificações push com o site fechado.
- `api/push.js`, `public/sw.js`: subscrições push (Blob privado da Vercel).
- `data/`: Trump 2024 por condado (NYT) e condados-chave do fio de @earlyvotedata. Gerar com `node tools/build-base.mjs && node tools/build-watch.mjs`.
- Teste local: `node tools/serve.js` → http://localhost:5190.
