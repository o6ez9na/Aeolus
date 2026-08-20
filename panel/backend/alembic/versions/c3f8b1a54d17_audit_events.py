"""audit events

Revision ID: c3f8b1a54d17
Revises: a7c41d0b93e2
Create Date: 2026-08-20 11:41:07.905612

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3f8b1a54d17'
down_revision: Union[str, Sequence[str], None] = 'a7c41d0b93e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'audit_events',
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('actor_user_id', sa.Uuid(), nullable=True),
        sa.Column('actor_username', sa.String(length=64), nullable=True),
        sa.Column('actor_role', sa.String(length=16), nullable=True),
        sa.Column('actor_ip', sa.String(length=45), nullable=True),
        sa.Column('action', sa.String(length=48), nullable=False),
        sa.Column('target_type', sa.String(length=32), nullable=True),
        sa.Column('target_id', sa.String(length=64), nullable=True),
        sa.Column('target_label', sa.String(length=128), nullable=True),
        sa.Column('detail', sa.JSON(), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(['actor_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_audit_events_created_at'), 'audit_events', ['created_at'])
    op.create_index(op.f('ix_audit_events_action'), 'audit_events', ['action'])
    op.create_index(op.f('ix_audit_events_actor_username'), 'audit_events', ['actor_username'])
    op.create_index(op.f('ix_audit_events_target_type'), 'audit_events', ['target_type'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_audit_events_target_type'), table_name='audit_events')
    op.drop_index(op.f('ix_audit_events_actor_username'), table_name='audit_events')
    op.drop_index(op.f('ix_audit_events_action'), table_name='audit_events')
    op.drop_index(op.f('ix_audit_events_created_at'), table_name='audit_events')
    op.drop_table('audit_events')
