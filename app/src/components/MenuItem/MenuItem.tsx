import { IonIcon } from '@ionic/react';
import React, { MouseEvent, Component } from 'react';
import {
	personAddOutline,
	handRightOutline,
	closeCircleOutline,
	videocamOutline,
	videocamOffOutline,
	micOutline,
	micOffOutline,
	laptopOutline,
	easelOutline,
	personRemoveOutline,
	chatbubbleEllipsesOutline,
	lockClosedOutline,
	lockOpenOutline,
	sparklesOutline,
} from 'ionicons/icons';
import styles from './MenuItem.module.scss';

type Icons = Record<MenuItemName, string>;

export type MenuItemName =
  | 'invite'
  | 'raiseHand'
  | 'end'
  | 'video'
  | 'audio'
  | 'screenShare'
  | 'whiteboard'
  | 'memberRemove'
  | 'chat'
  | 'lock'
  | 'noise'

export interface MenuItemProps {
  name: MenuItemName;
  active: boolean;
  visibility: boolean;
  /** a count shown on the icon (unread chat messages) */
  badge?: number;
  handleClick: (event: MouseEvent) => void;
}

interface Switch {
	on: string;
	off: string;
	labelOn: string;
	labelOff: string;
}

/** The two switches: the icon shows what is happening now, with a slash when it is off. `active` means on. */
export const switches: Partial<Record<MenuItemName, Switch>> = {
	audio: { on: micOutline, off: micOffOutline, labelOn: 'Mute microphone', labelOff: 'Unmute microphone' },
	video: { on: videocamOutline, off: videocamOffOutline, labelOn: 'Turn camera off', labelOff: 'Turn camera on' },
	// on = the meeting is locked: the button then unlocks it
	lock: { on: lockClosedOutline, off: lockOpenOutline, labelOn: 'Unlock meeting', labelOff: 'Lock meeting' },
	// on = background noise is being removed from the microphone: the button then turns that off
	noise: { on: sparklesOutline, off: sparklesOutline, labelOn: 'Turn noise reduction off', labelOff: 'Turn noise reduction on' },
};

const labels: Record<MenuItemName, string> = {
	invite: 'Copy invitation',
	raiseHand: 'Raise hand',
	end: 'End meeting',
	video: 'Camera',
	audio: 'Microphone',
	screenShare: 'Share screen',
	whiteboard: 'Whiteboard',
	memberRemove: 'Remove member',
	chat: 'Chat',
	lock: 'Lock meeting',
	noise: 'Noise reduction',
};

export default class MenuItem extends Component<MenuItemProps> {
	icons: Icons = {
		invite: personAddOutline,
		raiseHand: handRightOutline,
		end: closeCircleOutline,
		video: videocamOutline,
		audio: micOutline,
		screenShare: laptopOutline,
		whiteboard: easelOutline,
		memberRemove: personRemoveOutline,
		chat: chatbubbleEllipsesOutline,
		lock: lockOpenOutline,
		noise: sparklesOutline,
	};

	get switch() {
		return switches[this.props.name];
	}

	/** A switch that is off is shown at full strength (dark), not faded: it must be easy to see that it is off. */
	get iconClass() {
		const { active } = this.props;
		const state = this.switch ? (active ? styles.active : styles.off) : active && styles.active;
		return `${styles.icon} ${state}`;
	}

	get icon() {
		const toggle = this.switch;
		if (toggle) return this.props.active ? toggle.on : toggle.off;
		return this.icons[this.props.name];
	}

	get label() {
		const toggle = this.switch;
		if (toggle) return this.props.active ? toggle.labelOn : toggle.labelOff;
		return labels[this.props.name];
	}

	render() {
		return (
			this.props.visibility && (
				<div className={styles.menuItem} onClick={this.props.handleClick} role="button" aria-label={this.label} title={this.label}>
					<IonIcon className={this.iconClass} icon={this.icon} />
					{this.props.badge ? <span className={styles.badge} aria-label={`${this.props.badge} unread`}>{this.props.badge > 9 ? '9+' : this.props.badge}</span> : null}
				</div>
			)
		);
	}
}
