import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200, default: 'New chat' })
  title: string;

  /** Running summary of turns that no longer fit the context budget. */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** Highest message id already folded into `summary`. */
  @Column({ type: 'int', default: 0 })
  summarizedUpTo: number;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('messages')
@Index(['conversation', 'id'])
export class Message {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE', nullable: false })
  conversation: Conversation;

  @Column({ type: 'varchar', length: 16 })
  role: 'user' | 'assistant';

  @Column({ type: 'text' })
  content: string;

  /** complete, or stopped when the user cancelled mid-stream (partial text is kept). */
  @Column({ type: 'varchar', length: 16, default: 'complete' })
  status: 'complete' | 'stopped';

  @CreateDateColumn()
  createdAt: Date;
}
