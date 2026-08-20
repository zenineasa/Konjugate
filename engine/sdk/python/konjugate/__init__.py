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


@dataclass(frozen=True)
class NodeProviderDescription:
    provider_id: str
    name: str
    inputs: Sequence[ScalarPort]
    outputs: Sequence[ScalarPort]


class NodeOutputCollector:
    """Collect derivative contributions keyed by declared output port."""

    def __init__(self):
        self._gradients = {}

    def add_gradient(self, key: str, value: float) -> None:
        self._gradients[key] = self._gradients.get(key, 0.0) + float(value)

    @property
    def gradients(self) -> Mapping[str, float]:
        return MappingProxyType(dict(self._gradients))


class NodeProvider(ABC):
    """Checkpointable contract for future stateful computational-node providers."""

    @abstractmethod
    def describe(self) -> NodeProviderDescription:
        raise NotImplementedError

    def initialize(self, context: InitializationContext) -> None:
        del context

    @abstractmethod
    def evaluate(
        self,
        context: EvaluationContext,
        inputs: InputView,
        outputs: NodeOutputCollector,
    ) -> None:
        raise NotImplementedError

    @abstractmethod
    def checkpoint(self) -> bytes:
        """Return deterministic provider state for a simulation checkpoint."""
        raise NotImplementedError

    @abstractmethod
    def restore(self, payload: bytes) -> None:
        """Restore state produced by checkpoint()."""
        raise NotImplementedError

    def shutdown(self) -> None:
        pass


__all__ = [
    "EvaluationContext",
    "InitializationContext",
    "InputView",
    "OutputCollector",
    "NodeOutputCollector",
    "NodeProvider",
    "NodeProviderDescription",
    "RelationshipDescription",
    "RelationshipProvider",
    "ScalarPort",
]
