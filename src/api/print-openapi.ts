/** Print the OpenAPI document: `npm run openapi` writes it to openapi.json. */

import { openapiDocument } from "./openapi.ts";

process.stdout.write(`${JSON.stringify(openapiDocument(), null, 2)}\n`);
