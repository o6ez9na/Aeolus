"""keep the import password readable, and give every client one

Revision ID: a3d5f7b9c1e2
Revises: f1c7a9e3b5d8
Create Date: 2026-10-30 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.core.crypto import encrypt_secret
from app.core.security import generate_password, hash_password


# revision identifiers, used by Alembic.
revision: str = 'a3d5f7b9c1e2'
down_revision: Union[str, Sequence[str], None] = 'f1c7a9e3b5d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('clients', sa.Column('import_password_enc', sa.Text(), nullable=True))
    # Only hashes existed until now, so the old passwords cannot be shown: every
    # client gets a new one. A profile already imported into Connect does not
    # use it again, so nothing that works stops working.
    conn = op.get_bind()
    clients = sa.table(
        'clients',
        sa.column('id'),
        sa.column('import_password_hash', sa.String),
        sa.column('import_password_enc', sa.Text),
    )
    for (client_id,) in conn.execute(sa.select(clients.c.id)).all():
        password = generate_password()
        conn.execute(
            clients.update()
            .where(clients.c.id == client_id)
            .values(
                import_password_hash=hash_password(password),
                import_password_enc=encrypt_secret(password),
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('clients', 'import_password_enc')
