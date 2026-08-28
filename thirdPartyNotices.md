<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Third-party notices

Konjugate may distribute the following third-party software with its native
simulation engine.

## METIS 5.1.0

METIS is used for graph partitioning.

Copyright 1995–2013, Regents of the University of Minnesota

METIS is licensed under the Apache License, Version 2.0. Its upstream notice
is reproduced in `thirdPartyLicenses/metis.txt` and the complete license is
available in `thirdPartyLicenses/apache2.txt`.

Konjugate does not modify METIS source code. On macOS, the distributed
library's dynamic-loader install name may be adjusted solely so the library
can be loaded from the application bundle.

## GKlib (bundled with METIS)

Copyright 1995–2018, Regents of the University of Minnesota

GKlib is licensed under the Apache License, Version 2.0. Its upstream notice
is reproduced in `thirdPartyLicenses/gklib.txt` and the complete license is
available in `thirdPartyLicenses/apache2.txt`.

## Boost.PropertyTree 1.91.0 (and its transitive Boost components)

Copyright Boost.org and individual Boost contributors.

Used for parsing and representing the JSON project document. Every Boost
component this pulls in transitively is licensed under the Boost Software
License, Version 1.0, reproduced in full in
`thirdPartyLicenses/boostSoftwareLicense1.0.txt`.

## Eigen 5.0.1

Copyright Eigen contributors.

Konjugate includes only Eigen's core dense linear algebra headers
(`Eigen/Dense`), used for causal-inference matrix computations. That core is
licensed under the Mozilla Public License, Version 2.0 — the same license as
Konjugate itself. See the repository's own `LICENSE` file for the complete
text; no separate copy is reproduced here. (Eigen's source distribution also
bundles a small number of files under other MPL2-compatible licenses for
optional modules Konjugate does not include; those do not apply here.)

## NLopt 2.11.0

Copyright (c) 2007-2024 Massachusetts Institute of Technology

Used for the derivative-free and gradient-based optimization backends behind
digital-twin parameter tuning. NLopt optionally bundles Luksan-derived
algorithms under the LGPL; Konjugate's build explicitly excludes that
optional feature (`vcpkg.json` requests plain `nlopt`, without the `luksan`
feature), so the library as distributed here is licensed under the plain MIT
License. Its upstream notice, which documents both cases, is reproduced in
`thirdPartyLicenses/nlopt.txt`.

## OpenSSL 3.6.3

Copyright The OpenSSL Project Authors.

Used by Protocol Buffers' build tooling. OpenSSL is licensed under the
Apache License, Version 2.0, available in `thirdPartyLicenses/apache2.txt`.

## Protocol Buffers 6.33.4

Copyright 2008 Google Inc.

Used for the engine report and streaming-event wire formats
(`protocol/engineProtocol.proto`). Licensed under a BSD-3-Clause variant,
reproduced in `thirdPartyLicenses/protobuf.txt`.

## Abseil 20260107.1 (transitive dependency of Protocol Buffers)

Copyright The Abseil Authors.

Not declared directly in `vcpkg.json` — pulled in transitively by protobuf.
Licensed under the Apache License, Version 2.0, available in
`thirdPartyLicenses/apache2.txt`.

## utf8_range 6.33.4 (transitive dependency of Protocol Buffers)

Copyright (c) 2019 Yibo Cai, Copyright 2022 Google LLC

Not declared directly in `vcpkg.json` — pulled in transitively by protobuf.
Licensed under the MIT License, reproduced in
`thirdPartyLicenses/utf8Range.txt`.

## zlib 1.3.2

Copyright (C) 1995-2026 Jean-loup Gailly and Mark Adler

Used for project file compression. Licensed under the zlib License,
reproduced in `thirdPartyLicenses/zlib.txt`.

