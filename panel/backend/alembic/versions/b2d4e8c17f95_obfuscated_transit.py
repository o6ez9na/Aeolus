"""per-node obfuscated transit

Revision ID: b2d4e8c17f95
Revises: f7a3c9d2e481
Create Date: 2026-08-20 13:10:44.882014

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2d4e8c17f95'
down_revision: Union[str, Sequence[str], None] = 'f7a3c9d2e481'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'nodes',
        sa.Column('transit_obfuscated', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column('nodes', 'transit_obfuscated', server_default=None)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('nodes', 'transit_obfuscated')
