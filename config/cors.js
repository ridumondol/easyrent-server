const defaultOrigins = [
  'https://easyrent-client.vercel.app',
  'http://localhost:3000',
];

export function getAllowedOrigins(clientUrl = '', corsOrigin = '') {
  const configuredOrigins = [clientUrl, corsOrigin]
    .flatMap((origins) => origins.split(','))
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set([...defaultOrigins, ...configuredOrigins]);
}
