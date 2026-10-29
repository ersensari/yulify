import { buildExtension } from '@pithagoras/extension-api/build';
await buildExtension({ dir: import.meta.dirname, server: 'src/server.ts' });
