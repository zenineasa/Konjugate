# Copyright © 2026 Zenin Easa Panthakkalakath

"""Author-facing contract for Konjugate relationship providers."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Sequence


@dataclass(frozen=True)
class ScalarPort:
    key: str
    name: str
    unit: str = ""


@dataclass(frozen=True)
class RelationshipDescription:
    provider_id: str
    name: str
    inputs: Sequence[ScalarPort]
    output: ScalarPort


@dataclass(frozen=True)
class InitializationContext:
    instance_id: int


@dataclass(frozen=True)
class EvaluationContext:
    simulation_time: float
    step_size: float


class InputView:
    """Read-only scalar inputs keyed by the provider's stable port identifiers."""

    def __init__(self, values: Mapping[str, float]):
        self._values = MappingProxyType(dict(values))

    def __getitem__(self, key: str) -> float:
        return self._values[key]

    def __len__(self) -> int:
        return len(self._values)


class OutputCollector:
    """Collects the provider's additive contribution to one bound derivative."""

    def __init__(self):
        self._gradient = 0.0

    def add_gradient(self, value: float) -> None:
        self._gradient += float(value)

    @property
    def gradient(self) -> float:
        return self._gradient


class RelationshipProvider(ABC):
    @abstractmethod
    def describe(self) -> RelationshipDescription:
        raise NotImplementedError

    def initialize(self, context: InitializationContext) -> None:
        del context

    @abstractmethod
    def evaluate(
        self,
        context: EvaluationContext,
        inputs: InputView,
        outputs: OutputCollector,
    ) -> None:
        raise NotImplementedError

    def shutdown(self) -> None:
        pass


__all__ = [
    "EvaluationContext",
    "InitializationContext",
    "InputView",
    "OutputCollector",
    "RelationshipDescription",
    "RelationshipProvider",
    "ScalarPort",
]
