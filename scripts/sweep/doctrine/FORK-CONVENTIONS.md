# Fork conventions

Conventions this fork follows that a resolution must respect. They are not
visible from a single conflict, which is why they are written down; everything
else you need is in the code around the conflict itself.

## Database migrations

Upstream and this fork both add migrations under `src/db/migrations/`, so their
numbers collide. The fork side-numbers its own: files are named `NN-fls-MM` and
the symbols are `flsMigrationNNN`.

When a migration number collides, renumber the FORK's migration. Never renumber
upstream's — an upstream migration that has already run in a deployment cannot be
given a new number without breaking it.
