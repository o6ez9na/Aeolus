"""Separate ciphers for clients and for the transit between nodes

Revision ID: c5f1e8a3d6b2
Revises: a9d2c6e4f1b7
Create Date: 2026-11-04 00:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5f1e8a3d6b2'
down_revision: Union[str, Sequence[str], None] = 'a9d2c6e4f1b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column('nodes', 'data_cipher', new_column_name='client_cipher')
    op.add_column('nodes', sa.Column('transit_cipher', sa.String(length=32), nullable=True))
    # The one cipher so far covered the transit too: keep the transit on it.
    op.execute("UPDATE nodes SET transit_cipher = client_cipher WHERE is_hub")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('nodes', 'transit_cipher')
    op.alter_column('nodes', 'client_cipher', new_column_name='data_cipher')
