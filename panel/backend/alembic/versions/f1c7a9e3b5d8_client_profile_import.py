"""password for importing a client profile into OpenVPN Connect

Revision ID: f1c7a9e3b5d8
Revises: e6b1d3f8a2c4
Create Date: 2026-10-30 12:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1c7a9e3b5d8'
down_revision: Union[str, Sequence[str], None] = 'e6b1d3f8a2c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('clients', sa.Column('import_password_hash', sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('clients', 'import_password_hash')
