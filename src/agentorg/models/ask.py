"""Asks: decisions waiting on the user, the unit of the decisions page."""

from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from agentorg.models.common import (
    CONTEXT_MAX,
    WORDS_MAX,
    ContractModel,
    Id,
    Short,
    Timestamp,
    Title,
)

AskState = Literal["open", "answered"]
AnswerChannel = Literal["page", "session", "api"]

OPTIONS_MIN = 2
OPTIONS_MAX = 6

Context = Annotated[str, StringConstraints(min_length=1, max_length=CONTEXT_MAX)]
Words = Annotated[str, StringConstraints(min_length=1, max_length=WORDS_MAX)]
Detail = Annotated[str, StringConstraints(min_length=1, max_length=300)]


class Option(ContractModel):
    label: Short = Field(description="The button text; unique within the ask.")
    detail: Detail | None = Field(default=None, description="One sentence on what it means.")


class Answer(ContractModel):
    choice: Short | None = Field(description="The label of the chosen option, if one was chosen.")
    words: Words | None = Field(description="The user's own words, quoted.")
    channel: AnswerChannel
    answered_at: Timestamp


class Ask(ContractModel):
    id: Id
    task: Id | None
    session: Id = Field(description="The session that asked.")
    title: Title
    context: Context
    options: list[Option]
    recommendation: Short
    state: AskState
    answer: Answer | None
    opened_at: Timestamp


class AskOpen(ContractModel):
    session: Id = Field(description="The asking session.")
    task: Id | None = Field(default=None, description="Defaults to the asking session's task.")
    title: Title = Field(description="The decision, as a short question.")
    context: Context = Field(description="Two or three sentences for a reader outside the session.")
    options: list[Option] = Field(min_length=OPTIONS_MIN, max_length=OPTIONS_MAX)
    recommendation: Short = Field(description="The label of the recommended option.")

    @model_validator(mode="after")
    def _options_and_recommendation(self) -> "AskOpen":
        labels = [option.label for option in self.options]
        if len(set(labels)) != len(labels):
            raise ValueError("option labels must be unique")
        if self.recommendation not in labels:
            raise ValueError("recommendation must be the label of one of the options")
        return self


class AskGet(ContractModel):
    ask: Id


class AskWait(ContractModel):
    ask: Id
    timeout_seconds: float | None = Field(
        default=None,
        gt=0,
        description="Return the ask, still open, after this long; null waits until it is answered.",
    )


class AskAnswer(ContractModel):
    """The user's answer, given on the decisions page or through the API."""

    ask: Id
    choice: Short | None = Field(default=None, description="The label of the chosen option.")
    words: Words | None = Field(default=None, description="An optional note in the user's words.")

    @model_validator(mode="after")
    def _choice_or_words(self) -> "AskAnswer":
        if self.choice is None and self.words is None:
            raise ValueError("an answer needs a choice, the user's words, or both")
        return self


class AskRecordAnswer(ContractModel):
    """An answer the user gave inside the asking session's own conversation."""

    session: Id = Field(description="The asking session; only it records answers to its asks.")
    ask: Id
    words: Words = Field(description="The user's words, quoted exactly.")
    choice: Short | None = Field(default=None, description="The option those words choose, if any.")


class AskList(ContractModel):
    state: AskState | None = Field(default="open", description="Null lists every ask.")


class AskListResult(ContractModel):
    asks: list[Ask]
