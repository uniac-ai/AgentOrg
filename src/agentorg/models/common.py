"""Types shared by every record and request."""

from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, StringConstraints

# Size caps. The service refuses longer text, which keeps logs out of the record.
ID_MAX = 64
SHORT_MAX = 80
TITLE_MAX = 200
CONTEXT_MAX = 1000
SUMMARY_MAX = 2000
REF_MAX = 2000
OUTCOME_MAX = 4000
WORDS_MAX = 4000

Id = Annotated[str, StringConstraints(min_length=1, max_length=ID_MAX)]
Short = Annotated[str, StringConstraints(min_length=1, max_length=SHORT_MAX)]
Title = Annotated[str, StringConstraints(min_length=1, max_length=TITLE_MAX)]
Ref = Annotated[str, StringConstraints(min_length=1, max_length=REF_MAX)]
Timestamp = AwareDatetime


class ContractModel(BaseModel):
    """Base of every record and request: unknown fields are refused, text is stripped."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Link(ContractModel):
    label: Short
    url: Ref


class ErrorBody(ContractModel):
    """The body of every API error response."""

    code: str
    message: str
