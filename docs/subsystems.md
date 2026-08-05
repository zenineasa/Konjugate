<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Subsystems

Subsystems are authored hierarchy over Konjugate's graph, not separate simulation entities. A subsystem owns a stable numeric ID, a parent subsystem ID, a display position and explicit boundary ports. Nodes retain their original IDs and identify the subsystem that contains them. Relationships also retain their original endpoints and IDs.

Creating a subsystem from selected nodes derives one port for every relationship with exactly one selected endpoint. Each port records the crossing relationship, its internal and external node and whether the internal node is the relationship source or target. Internal relationships do not require ports. This representation supports multiple relationships between the same pair of nodes without merging their identities.

The parent view renders a subsystem proxy. A relationship that crosses the boundary is drawn to that proxy, while relationships whose endpoints are both inside the subsystem are hidden at the parent level. Opening the proxy shows its direct member nodes and nested subsystem proxies. The breadcrumb returns to the parent view.

Hierarchy visibility is independent of deletion. Saving a project always includes every undeleted graph entity, including entities outside the active hierarchy view. Before validation or simulation, Electron removes subsystem metadata and sends the native engine the same flat node-and-edge graph that would exist without subsystems. The C++ validator therefore remains the source of truth and numerical behavior is unchanged.
