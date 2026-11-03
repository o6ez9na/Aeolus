"""The data-channel cipher the whole panel runs on, and which nodes can do GOST

Revision ID: a9d2c6e4f1b7
Revises: b8e3d1f6a947
Create Date: 2026-11-03 18:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a9d2c6e4f1b7'
down_revision: Union[str, Sequence[str], None] = 'b8e3d1f6a947'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('nodes', sa.Column('data_cipher', sa.String(length=32), nullable=True))
    op.add_column('nodes', sa.Column('gost_capable', sa.Boolean(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('nodes', 'gost_capable')
    op.drop_column('nodes', 'data_cipher')
