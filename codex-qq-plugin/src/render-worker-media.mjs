// Standalone Canvas renderer. No QQ transport, credentials, tools or network.
const renderers = {
  weather: async inputs => (await import('./weather-report-image.mjs')).renderWeatherReportImage({inputs}),
  air: async inputs => (await import('./air-chart.mjs')).renderAirChart(inputs),
  hiking: async inputs => (await import('./hiking-card-image.mjs')).renderHikingCard(inputs),
  status: async inputs => (await import('./provider-status-image.mjs')).renderProviderStatusImage(inputs),
};

const kind = process.argv[2];
if (!Object.hasOwn(renderers,kind)) throw new Error('UNKNOWN_RENDERER');
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 256 * 1024) throw new Error('RENDER_INPUT_TOO_LARGE');
  chunks.push(chunk);
}
const inputs = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const {buffer} = await renderers[kind](inputs);
process.stdout.write(buffer);
