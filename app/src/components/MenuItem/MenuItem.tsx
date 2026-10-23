import { IonIcon } from '@ionic/react';
import React, { MouseEvent, Component } from 'react';
import {
	personAddOutline,
	handRightOutline,
	closeCircleOutline,
	videocamOutline,
	micOutline,
	laptopOutline,
	easelOutline,
	personRemoveOutline,
	chatbubbleEllipsesOutline,
} from 'ionicons/icons';
import styles from './MenuItem.module.scss';

type Icons = Record<MenuItemName, string>;

type MenuItemName =
  | 'invite'
  | 'raiseHand'
  | 'end'
  | 'video'
  | 'audio'
  | 'screenShare'
  | 'whiteboard'
  | 'memberRemove'
  | 'chat'

export interface MenuItemProps {
  name: MenuItemName;
  active: boolean;
  visibility: boolean;
  /** a count shown on the icon (unread chat messages) */
  badge?: number;
  handleClick: (event: MouseEvent) => void;
}

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
	};

	get iconClass() {
		const activeClass = this.props.active && styles.active;
		return `${styles.icon} ${activeClass}`;
	}

	get icon() {
		return this.icons[this.props.name];
	}

	render() {
		return (
			this.props.visibility && (
				<div className={styles.menuItem} onClick={this.props.handleClick}>
					<IonIcon className={this.iconClass} icon={this.icon} />
					{this.props.badge ? <span className={styles.badge} aria-label={`${this.props.badge} unread`}>{this.props.badge > 9 ? '9+' : this.props.badge}</span> : null}
				</div>
			)
		);
	}
}
