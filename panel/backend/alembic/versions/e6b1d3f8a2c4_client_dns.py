"""DNS servers the hub pushes to clients

Revision ID: e6b1d3f8a2c4
Revises: d4a8c2e6f913
Create Date: 2026-10-30 11:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e6b1d3f8a2c4'
down_revision: Union[str, Sequence[str], None] = 'd4a8c2e6f913'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('nodes', sa.Column('client_dns', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('nodes', 'client_dns')
