import { IonCol, IonContent, IonGrid, IonPage, IonRow } from '@ionic/react'
import React, { Component } from 'react'
import { RouteComponentProps, withRouter } from '../../components/withRouter/withRouter'
import { connect } from 'react-redux'
import AdminMiddleware from '../../middleware/AdminMiddleware'
import EditorService from '../../services/Editor/EditorService'
import Request from './PrivacyEdit.request'
import { actions, selectors, PrivacyEditState, PrivacyEditActions } from './PrivacyEdit.state'
import Page from '../../components/Page/Page'
import AdminMenu from '../../components/AdminMenu/AdminMenu'
import Button from '../../components/Button/Button'
import styles from './PrivacyEdit.module.scss'

interface PrivacyEditProps extends
  PrivacyEditState, PrivacyEditActions, RouteComponentProps {}

class PrivacyEdit extends Component<PrivacyEditProps> {
  adminMiddleware: AdminMiddleware
  editorService: EditorService
  request: Request

  constructor (props: PrivacyEditProps) {
    super(props)
    this.adminMiddleware = new AdminMiddleware()
    this.editorService = new EditorService()
    this.request = new Request()
    this.handleSaveClick = this.handleSaveClick.bind(this)
  }

  setPrivacy () {
    this.request.read(privacy => {
      this.props.replacePrivacy(privacy)
      this.editorService.setContent(privacy)
    })
  }

  handlePrivacyChange () {
    this.editorService.onContentChange(privacy => {
      this.props.replacePrivacy(privacy)
    })
  }

  handleSaveClick () {
    this.request.update(this.props.privacy)
  }

  componentDidMount () {
    this.adminMiddleware.auth(this.props.history)
    this.editorService.initialize('#privacyEitor')
    this.setPrivacy()
    this.handlePrivacyChange()
  }

  render () {
    return (
      <IonPage>
        <IonContent>
          <Page
            invert={false}
            container="regular">
            <IonGrid>
              <IonRow>
                <IonCol>
                  <AdminMenu />
                  <div className={styles.privacyEdit}>
                    <div id="privacyEitor" />
                    <div className={styles.save}>
                      <Button
                        text="Save"
                        handleClick={this.handleSaveClick} />
                    </div>
                  </div>
                </IonCol>
              </IonRow>
            </IonGrid>
          </Page>
        </IonContent>
      </IonPage>
    )
  }
}

export default withRouter(connect(selectors, actions)(PrivacyEdit))
