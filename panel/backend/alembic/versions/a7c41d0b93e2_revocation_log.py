"""revocation log that outlives the client row

Revision ID: a7c41d0b93e2
Revises: 641116e53cf5
Create Date: 2026-08-20 11:02:15.442310

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7c41d0b93e2'
down_revision: Union[str, Sequence[str], None] = '641116e53cf5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'revoked_certificates',
        sa.Column('serial', sa.String(length=64), nullable=False),
        sa.Column('common_name', sa.String(length=64), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('reason', sa.String(length=64), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('serial'),
    )
    op.create_index(
        op.f('ix_revoked_certificates_serial'), 'revoked_certificates', ['serial'], unique=True
    )

    # Carry over the clients revoked before this table existed, otherwise the
    # next CRL rebuild would quietly un-revoke them.
    op.execute(
        """
        INSERT INTO revoked_certificates (id, serial, common_name, revoked_at, reason)
        SELECT gen_random_uuid(), cert_serial, common_name, revoked_at, 'migrated'
        FROM clients
        WHERE revoked_at IS NOT NULL AND cert_serial IS NOT NULL
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_revoked_certificates_serial'), table_name='revoked_certificates')
    op.drop_table('revoked_certificates')
