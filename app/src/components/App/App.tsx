import { IonApp, setupIonicReact } from '@ionic/react'
import React, { Component } from 'react'
import { Route } from 'react-router-dom'
import routes from '../../routes'
import SocketService from '../../services/SocketService'
import IceService from '../../services/IceService'
import DisplayNameService from '../../services/DisplayNameService'
import NoiseSuppressionService from '../../services/NoiseSuppressionService'
import AlertService from '../../services/AlertService'
import LocalStorage from './App.storage'
import Provider from '../Provider/Provider'
import '@ionic/react/css/core.css'
import '@ionic/react/css/normalize.css'
import '@ionic/react/css/structure.css'
import '@ionic/react/css/typography.css'
import '@ionic/react/css/padding.css'
import '@ionic/react/css/float-elements.css'
import '@ionic/react/css/text-alignment.css'
import '@ionic/react/css/text-transformation.css'
import '@ionic/react/css/flex-utils.css'
import '@ionic/react/css/display.css'
import '../../theme/fonts.scss'
import '../../theme/variables.css'
import '../../theme/quill.scss'

export default class App extends Component {
  localStorage: LocalStorage

  constructor (props: object) {
    super(props)
    this.localStorage = new LocalStorage()
    this.setupConfig()
    SocketService.connect()
    IceService.start()
    void DisplayNameService.load() // the name this person chose earlier on this device, ready for the next meeting
    void NoiseSuppressionService.load() // and whether they switched noise reduction off
  }

  setupConfig () {
    setupIonicReact({ mode: 'md' })
  }

  async handlePwaInstall (event: Event) {
    const deferredPrompt: any = event
    deferredPrompt.prompt()
    const choiceResult = await deferredPrompt.userChoice
    const isAccepted = (choiceResult.outcome === 'accepted')
    if (isAccepted) AlertService.pull()
  }

  promptPwaInstall () {
    this.localStorage.checkPwaPrompted(pwaPrompted => {
      if (pwaPrompted) return
      window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault()
        this.localStorage.setPwaInstallPrompted(() => {
          const installHandler = () => this.handlePwaInstall(event)
          AlertService.push('Install app?', installHandler)
        })
      })
    })
  }

  componentDidMount () {
    this.promptPwaInstall()
  }

  render () {
    return (
      <IonApp>
        <Provider>
          <Route
            path={routes.preload.path}
            element={<routes.preload.component />} />
          <Route
            path={routes.home.path}
            element={<routes.home.component />} />
          <Route
            path={routes.join.path}
            element={<routes.join.component />} />
          <Route
            path={routes.start.path}
            element={<routes.start.component />} />
          <Route
            path={routes.meeting.path}
            element={<routes.meeting.component />} />
          <Route
            path={routes.install.path}
            element={<routes.install.component />} />
          <Route
            path={routes.adminSignIn.path}
            element={<routes.adminSignIn.component />} />
          <Route
            path={routes.hosts.path}
            element={<routes.hosts.component />} />
          <Route
            path={routes.privacy.path}
            element={<routes.privacy.component />} />
          <Route
            path={routes.privacyEdit.path}
            element={<routes.privacyEdit.component />} />
          <Route
            path={routes.notFound.path}
            element={<routes.notFound.component />} />
        </Provider>
      </IonApp>
    )
  }
}
