import React, { Component } from 'react'
import { NavLink } from 'react-router-dom'
import { RouteComponentProps, withRouter } from '../withRouter/withRouter'
import routes from '../../routes'
import AppStorage from '../App/App.storage'
import styles from './AdminMenu.module.scss'

interface AdminMenuProps extends RouteComponentProps {}

class AdminMenu extends Component<AdminMenuProps> {
  appStorage: AppStorage

  constructor (props: AdminMenuProps) {
    super(props)
    this.appStorage = new AppStorage()
    this.handleSignOutClick = this.handleSignOutClick.bind(this)
  }

  handleSignOutClick () {
    this.appStorage.removeAccessToken(() => {
      this.props.history.push(routes.adminSignIn.path)
    })
  }

  activeClassName ({ isActive }: { isActive: boolean }) {
    return isActive ? `${styles.menuItem} ${styles.active}` : styles.menuItem
  }

  render () {
    return (
      <div className={styles.adminMenu}>
        <div className={styles.menuItems}>
          <NavLink
            className={this.activeClassName}
            to={routes.hosts.path}>
            Hosts
          </NavLink>
          <NavLink
            className={this.activeClassName}
            to={routes.privacyEdit.path}>
            Privacy Policy
          </NavLink>
          <NavLink
            className={styles.menuItem}
            to="#"
            onClick={this.handleSignOutClick}>
            Sign Out
          </NavLink>
        </div>
      </div>
    )
  }
}

export default withRouter(AdminMenu)
