"""Evidence: files such as screenshots, uploaded once and referenced by items and reports.

The records are part of the contract; the design's phase 2 adds the operation that stores them.
"""

from typing import Literal

from pydantic import Field

from agentorg.models.common import ContractModel, Id, Ref, Short, Timestamp, Title

EvidenceKind = Literal["before", "after", "single"]


class Evidence(ContractModel):
    id: Id
    item: Id
    kind: EvidenceKind
    width: int | None = Field(gt=0, description="Display width in CSS pixels.")
    caption: Title
    file: Ref = Field(description="The stored file's path, relative to the files directory.")
    content_type: Short
    added_at: Timestamp


class EvidenceAdd(ContractModel):
    item: Id
    kind: EvidenceKind
    caption: Title
    width: int | None = Field(default=None, gt=0)
    path: Ref = Field(description="A local file the service copies into its files directory.")
