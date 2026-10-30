"""ui layouts: the network map's positions and groups

Revision ID: c9e1f4a7b302
Revises: b2d4e8c17f95
Create Date: 2026-10-29 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9e1f4a7b302'
down_revision: Union[str, Sequence[str], None] = 'b2d4e8c17f95'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'ui_layouts',
        sa.Column('key', sa.String(length=32), nullable=False),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_by_id', sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('key'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('ui_layouts')
