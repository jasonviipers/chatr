import { IonIcon } from '@ionic/react';
import { micOffOutline } from 'ionicons/icons';
import React, { Component } from 'react';
import styles from './MuteBadge.module.scss';

interface MuteBadgeProps {
  /** this participant's microphone is muted */
  muted: boolean;
  who: string;
}

/** A small slashed microphone in the corner of a tile: tells everybody that this person muted themselves. */
export default class MuteBadge extends Component<MuteBadgeProps> {
  render() {
    if (!this.props.muted) return null;
    const label = `${this.props.who} muted the microphone`;
    return (
      <div className={styles.muteBadge} role="img" aria-label={label} title={label}>
        <IonIcon icon={micOffOutline} />
      </div>
    );
  }
}
