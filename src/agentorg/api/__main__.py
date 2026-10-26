"""Print the OpenAPI document: `python -m agentorg.api > openapi.json`."""

import json

from agentorg.api import openapi_document

print(json.dumps(openapi_document(), indent=2))
