import { IonIcon, isPlatform } from '@ionic/react';
import { closeOutline, sendOutline } from 'ionicons/icons';
import React, { ChangeEvent, Component, KeyboardEvent, FormEvent } from 'react';
import { connect } from 'react-redux';
import MediaStateService from '../../services/MediaStateService';
import { selectors, ChatMessage, ChatState } from './Chat.state';
import { formatTime, senderHue, senderLabel } from './chatFormat';
import styles from './Chat.module.scss';

/** The same limit the server enforces. */
export const MAX_LENGTH = 1000;
/** Show a counter once the message gets close to it. */
const COUNTER_FROM = 800;

interface ChatOwnProps {
  /** this participant's peer id, and the host's (which is the meeting id) */
  myId: string;
  hostId: string;
  onSend: (text: string) => boolean;
  onRetry: (id: string) => void;
  onClose: () => void;
}

type ChatProps = ChatOwnProps & Pick<ChatState, 'open' | 'messages'>;

interface ChatLocalState {
  text: string;
}

export class Chat extends Component<ChatProps, ChatLocalState> {
  private readonly mediaState = new MediaStateService();
  private list: HTMLDivElement | null = null;
  private input: HTMLTextAreaElement | null = null;
  /** whether the list is scrolled to the end, so new messages follow along but reading older ones is not interrupted */
  private following = true;

  constructor(props: ChatProps) {
    super(props);
    this.state = { text: '' };
    this.handleChange = this.handleChange.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleScroll = this.handleScroll.bind(this);
  }

  componentDidMount() {
    if (this.props.open) document.addEventListener('keydown', this.handleDocumentKeyDown);
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.handleDocumentKeyDown);
  }

  componentDidUpdate(previous: ChatProps) {
    if (this.props.open !== previous.open) {
      if (this.props.open) document.addEventListener('keydown', this.handleDocumentKeyDown);
      else document.removeEventListener('keydown', this.handleDocumentKeyDown);
    }
    const { messages, open } = this.props;
    const last = messages[messages.length - 1];
    const grew = messages.length > previous.messages.length;
    if (open && (!previous.open || (grew && (this.following || last?.mine)))) this.scrollToEnd();
    if (open && !previous.open) this.input?.focus();
  }

  private scrollToEnd() {
    if (this.list) this.list.scrollTop = this.list.scrollHeight;
    this.following = true;
  }

  handleScroll() {
    const list = this.list;
    if (list) this.following = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  /** While the chat is open, Escape closes it wherever the focus happens to be. */
  private readonly handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key === 'Escape') this.props.onClose();
  };

  handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    this.setState({ text: event.target.value });
  }

  handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); // Enter sends, Shift+Enter writes a new line
      this.submit();
    }
  }

  handleSubmit(event: FormEvent) {
    event.preventDefault();
    this.submit();
  }

  private submit() {
    if (this.props.onSend(this.state.text)) {
      this.setState({ text: '' });
      this.input?.focus();
    }
  }

  private status(message: ChatMessage) {
    if (!message.mine) return null;
    if (message.status === 'sending') return <span className={styles.status}>Sending…</span>;
    if (message.status === 'failed') {
      return (
        <button type="button" className={`${styles.status} ${styles.retry}`} onClick={() => this.props.onRetry(message.id)}>
          Not sent · Retry
        </button>
      );
    }
    return null;
  }

  private renderMessage(message: ChatMessage) {
    const { myId, hostId } = this.props;
    const label = senderLabel(message.from, myId, hostId, (id) => this.mediaState.nameOf(id));
    const style = message.mine ? undefined : { color: `hsl(${senderHue(message.from)} 70% 72%)` };
    return (
      <li key={message.id} className={`${styles.message} ${message.mine ? styles.mine : ''}`}>
        <div className={styles.meta}>
          <span className={styles.sender} style={style}>
            {label}
          </span>
          <time className={styles.time}>{formatTime(message.at)}</time>
        </div>
        <div className={styles.bubble}>{message.text}</div>
        {this.status(message)}
      </li>
    );
  }

  render() {
    const { open, messages } = this.props;
    const { text } = this.state;
    const mobileClass = isPlatform('mobile') ? styles.mobile : '';
    const canSend = text.trim().length > 0;
    return (
      <aside className={`${styles.chat} ${open ? styles.open : ''} ${mobileClass}`} aria-label="Meeting chat" aria-hidden={!open}>
        <header className={styles.header}>
          <h2 className={styles.title}>Chat</h2>
          <button type="button" className={styles.close} aria-label="Close chat" onClick={this.props.onClose}>
            <IonIcon icon={closeOutline} />
          </button>
        </header>

        <div className={styles.listWrap}>
          <div className={styles.list} ref={(element) => {
              this.list = element;
            }} onScroll={this.handleScroll} role="log" aria-live="polite">
            {messages.length === 0 ? (
              <p className={styles.empty}>No messages yet. Write something to everyone in the meeting, handy when you cannot speak.</p>
            ) : (
              <ul className={styles.messages}>{messages.map((message) => this.renderMessage(message))}</ul>
            )}
          </div>
        </div>

        <form className={styles.form} onSubmit={this.handleSubmit}>
          <textarea
            ref={(element) => {
              this.input = element;
            }}
            className={styles.input}
            value={text}
            rows={Math.min(4, text.split('\n').length)}
            maxLength={MAX_LENGTH}
            placeholder="Type a message"
            aria-label="Message"
            tabIndex={open ? 0 : -1}
            onChange={this.handleChange}
            onKeyDown={this.handleKeyDown}
          />
          <button type="submit" className={styles.send} aria-label="Send message" disabled={!canSend} tabIndex={open ? 0 : -1}>
            <IonIcon icon={sendOutline} />
          </button>
          {text.length >= COUNTER_FROM && (
            <span className={styles.counter}>
              {text.length}/{MAX_LENGTH}
            </span>
          )}
        </form>
      </aside>
    );
  }
}

export default connect((state: { chat: ChatState }) => {
  const { open, messages } = selectors(state);
  return { open, messages };
})(Chat);
