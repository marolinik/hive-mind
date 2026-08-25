# Memory Substrate Publication

`marolinik/hive-mind` is the curated public distribution of the memory
substrate maintained in the private Waggle OS monorepo. Waggle OS is the
sole source of truth. The repositories are not bidirectional mirrors.

The former automatic cross-repository sync was retired in August 2026.
No workflow in this repository may hold credentials that can write to
Waggle OS or apply public commits there automatically.

## Maintainer forward-port

Every public update is prepared manually on a dedicated branch:

1. Land the substrate change in Waggle OS first. For an accepted public
   contribution, port and verify it in Waggle OS before publishing it back.
2. Run the private drift inventory and classify every reported difference.
3. Copy only the approved public subset, adapting package layout, imports,
   logging, and branding for this repository.
4. Remove Waggle-only security, governance, compliance, and product code.
5. Run `npm test`, `npm run lint`, and `npm run typecheck` here.
6. Open a normal pull request against `master` for human review and CI.

Never publish a raw subtree split, generated patch, or automated reverse
sync. Git history preserves the retired mechanism for audit purposes.

## External contributions

Public pull requests remain welcome. Contributors do not need access to
the private monorepo. A maintainer reviews the change here, ports accepted
work into Waggle OS, and includes it in a later curated forward-port.

`EXTRACTION.md` records historical package-boundary context; it is not an
automated publication procedure and cannot override this policy.
