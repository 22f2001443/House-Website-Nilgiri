import React, { useEffect, useState } from 'react';
import { Mail, User, Briefcase, Users } from 'lucide-react';
import client from '../api/client';
import { getLeadershipPriority, sortByLeadershipPriority } from '../lib/councilPriority';
import './ResourcesPage.css';

const ImportantContactsPage = () => {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchContacts = async () => {
      try {
        const response = await client.get('/contacts');
        setContacts(sortByLeadershipPriority(response.data.contacts || [], (contact) => contact.role));
      } catch (fetchError) {
        console.error('Failed to load important contacts:', fetchError);
      } finally {
        setLoading(false);
      }
    };

    fetchContacts();
  }, []);

  const hasContacts = contacts.length > 0;

  // Group contacts by Role
  const categorizedContacts = contacts.reduce((acc, contact) => {
      const role = contact.role || 'Other';
      if (!acc[role]) acc[role] = [];
      acc[role].push(contact);
      return acc;
  }, {});

  const roleColors = {
      UHC: '#a78bfa',
      LHC: '#60a5fa',
      'Web Administrator': '#34d399',
      'Community Admin': '#f59e0b',
      Mentor: '#f472b6',
      Other: '#a1a1aa'
  };

  return (
    <div className="resources-page important-contacts-page">
      <div className="resources-header-wrapper section-header">
        <span className="section-tag">Student Essentials</span>
        <h1 className="section-title">Important Contacts</h1>
        <div className="resources-intro-text">
          <p>
            Nilgiri House maintains a concise directory of student body contacts for the Secretary, Deputy Secretary, Web Admin, and other essential roles.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="resources-loading">Loading contacts…</div>
      ) : !hasContacts ? (
        <div className="resources-empty">the forest is quite right now, come back later to find something new here</div>
      ) : (
        <div className="resources-container">
          {Object.entries(categorizedContacts)
            .sort(([roleA], [roleB]) => {
              // UHC always comes first
              if ((roleA === 'UHC') !== (roleB === 'UHC')) return roleA === 'UHC' ? -1 : 1;
              const priorityDiff = getLeadershipPriority(roleA) - getLeadershipPriority(roleB);
              if (priorityDiff !== 0) return priorityDiff;
              return roleA.localeCompare(roleB);
            })
            .map(([role, items]) => {
            const color = roleColors[role] || '#34d399';
            const sortedItems = sortByLeadershipPriority(items, (contact) => contact.role);
            return (
              <div key={role} className="resource-section">
                <div className="resource-section-header">
                  <div className="resource-section-icon" style={{ background: `${color}15`, color: color }}>
                    <Users size={20} />
                  </div>
                  <h2 className="resource-section-title" style={{ color: color }}>{role}</h2>
                </div>
                <div className="resource-subsections">
                  <div>
                    <div className="resource-grid">
                      {sortedItems.map((contact) => (
                        <a key={contact.id} href={`mailto:${contact.email}`} className="resource-card">
                          <div className="resource-card-accent" style={{ background: color }}></div>
                          <div className="resource-card-header">
                            <h4 className="resource-card-title">{contact.name}</h4>
                            <User size={16} className="resource-card-icon" style={{ '--hover-color': color }} />
                          </div>

                          <div className="resource-card-desc-wrap">
                            <Briefcase size={12} className="resource-card-desc-icon" />
                            <p className="resource-card-desc">{contact.role}</p>
                          </div>
                          <div className="resource-card-desc-wrap" style={{ marginTop: '0.5rem' }}>
                            <Mail size={12} className="resource-card-desc-icon" />
                            <span className="resource-card-desc" style={{ color: 'inherit', textDecoration: 'none' }}>{contact.email}</span>
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ImportantContactsPage;
