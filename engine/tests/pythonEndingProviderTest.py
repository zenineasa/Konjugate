# Copyright © 2026 Zenin Easa Panthakkalakath

import sys

from konjugate import (
    RelationshipDescription,
    RelationshipProvider,
    ScalarPort,
)


class EndingProvider(RelationshipProvider):
    """A provider that says why on its stderr and ends at its first evaluation, as one does when the instrument it reads has gone:
    the engine's error must say which provider ended, during what, and what it said."""

    def describe(self):
        return RelationshipDescription(
            "test.ending",
            "Ending",
            [ScalarPort("delta", "Temperature difference", "K")],
            ScalarPort("gradient", "Temperature gradient", "K/s"),
        )

    def evaluate(self, context, inputs, outputs):
        sys.stderr.write("the rig is unplugged\n")
        sys.stderr.flush()
        sys.exit(3)
