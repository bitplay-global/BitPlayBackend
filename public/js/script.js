// Admin Panel JavaScript

document.addEventListener('DOMContentLoaded', function() {
    // Initialize admin panel
    initializeAdminPanel();
});

function initializeAdminPanel() {
    // Add smooth transitions
    addSmoothTransitions();
    
    // Initialize search functionality
    initializeSearch();
    
    // Initialize form validations
    initializeFormValidations();
    
    // Initialize tooltips
    initializeTooltips();
    
    // Auto-refresh dashboard data (admin dashboard)
    if (window.location.pathname === '/admin/dashboard' || window.location.pathname === '/dashboard') {
        setInterval(refreshDashboardData, 30000); // Refresh every 30 seconds
    }
}

function addSmoothTransitions() {
    // Add loading states to buttons
    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(button => {
        button.addEventListener('click', function() {
            if (!this.classList.contains('loading')) {
                this.classList.add('loading');
                setTimeout(() => {
                    this.classList.remove('loading');
                }, 1000);
            }
        });
    });
}

function initializeSearch() {
    const searchInput = document.querySelector('.search-box input');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            const searchTerm = this.value.toLowerCase();
            performSearch(searchTerm);
        });
    }
}

function performSearch(searchTerm) {
    // Search functionality for tables
    const tables = document.querySelectorAll('table tbody');
    tables.forEach(tbody => {
        const rows = tbody.querySelectorAll('tr');
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            if (text.includes(searchTerm)) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    });
}

function initializeFormValidations() {
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
        form.addEventListener('submit', function(e) {
            if (!validateForm(this)) {
                e.preventDefault();
            }
        });
    });
}

function validateForm(form) {
    let isValid = true;
    const requiredFields = form.querySelectorAll('[required]');
    
    requiredFields.forEach(field => {
        if (!field.value.trim()) {
            showFieldError(field, 'This field is required');
            isValid = false;
        } else {
            clearFieldError(field);
        }
    });
    
    // Email validation
    const emailFields = form.querySelectorAll('input[type="email"]');
    emailFields.forEach(field => {
        if (field.value && !isValidEmail(field.value)) {
            showFieldError(field, 'Please enter a valid email address');
            isValid = false;
        }
    });
    
    // Password confirmation
    const passwordField = form.querySelector('input[name="newPassword"]');
    const confirmField = form.querySelector('input[name="confirmPassword"]');
    if (passwordField && confirmField && passwordField.value !== confirmField.value) {
        showFieldError(confirmField, 'Passwords do not match');
        isValid = false;
    }
    
    return isValid;
}

function showFieldError(field, message) {
    clearFieldError(field);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'field-error';
    errorDiv.textContent = message;
    errorDiv.style.color = '#EF4444';
    errorDiv.style.fontSize = '12px';
    errorDiv.style.marginTop = '5px';
    field.parentNode.appendChild(errorDiv);
    field.style.borderColor = '#EF4444';
}

function clearFieldError(field) {
    const existingError = field.parentNode.querySelector('.field-error');
    if (existingError) {
        existingError.remove();
    }
    field.style.borderColor = '';
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function initializeTooltips() {
    // Add tooltips to action buttons
    const actionButtons = document.querySelectorAll('.btn-action');
    actionButtons.forEach(button => {
        button.addEventListener('mouseenter', function() {
            showTooltip(this);
        });
        
        button.addEventListener('mouseleave', function() {
            hideTooltip();
        });
    });
}

function showTooltip(element) {
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.style.position = 'absolute';
    tooltip.style.background = 'rgba(0, 0, 0, 0.8)';
    tooltip.style.color = 'white';
    tooltip.style.padding = '5px 10px';
    tooltip.style.borderRadius = '4px';
    tooltip.style.fontSize = '12px';
    tooltip.style.zIndex = '1000';
    tooltip.style.pointerEvents = 'none';
    
    if (element.classList.contains('view')) {
        tooltip.textContent = 'View Details';
    } else if (element.classList.contains('edit')) {
        tooltip.textContent = 'Edit';
    } else if (element.classList.contains('delete')) {
        tooltip.textContent = 'Delete';
    }
    
    document.body.appendChild(tooltip);
    
    const rect = element.getBoundingClientRect();
    tooltip.style.left = rect.left + (rect.width / 2) - (tooltip.offsetWidth / 2) + 'px';
    tooltip.style.top = rect.top - tooltip.offsetHeight - 5 + 'px';
}

function hideTooltip() {
    const tooltip = document.querySelector('.tooltip');
    if (tooltip) {
        tooltip.remove();
    }
}

function refreshDashboardData() {
    var form = document.querySelector('form[action="/admin/dashboard"]');
    var params = new URLSearchParams();
    if (form && form.getAttribute('data-range-all') === 'true') {
        params.set('range', 'all');
    } else {
        var startInput = document.querySelector('input[name="startDate"]');
        var endInput = document.querySelector('input[name="endDate"]');
        if (startInput && startInput.value) params.set('startDate', startInput.value);
        if (endInput && endInput.value) params.set('endDate', endInput.value);
    }
    var url = '/api/dashboard-stats' + (params.toString() ? '?' + params.toString() : '');
    fetch(url, { credentials: 'same-origin' })
        .then(response => response.json())
        .then(data => {
            if (data && !data.message) {
                updateDashboardStats(data);
            }
        })
        .catch(error => {
            console.error('Error refreshing dashboard data:', error);
        });
}

function updateDashboardStats(data) {
    const statValues = document.querySelectorAll('.stat-value');
    const fmt = (n) => (n != null ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0');
    if (statValues.length >= 1 && data.totalRevenue != null) statValues[0].textContent = '$' + fmt(data.totalRevenue);
    if (statValues.length >= 2 && data.totalWithdrawals != null) statValues[1].textContent = '$' + fmt(data.totalWithdrawals);
    if (statValues.length >= 3 && data.purchaseTotal != null) statValues[2].textContent = '$' + fmt(data.purchaseTotal);
    if (statValues.length >= 4 && data.usersCount != null) statValues[3].textContent = data.usersCount;
    if (statValues.length >= 5 && data.supportTicketsCount != null) statValues[4].textContent = data.supportTicketsCount;
    if (statValues.length >= 6) {
        const admobUsd = data.admobRevenueTotalUsd != null ? data.admobRevenueTotalUsd : data.admobRevenueTotal;
        statValues[5].textContent = '$' + fmt(admobUsd);
    }
    var admobSmall = document.querySelector('.admob-original-currency');
    if (admobSmall && data.admobCurrencyCode && data.admobCurrencyCode !== 'USD' && data.admobRevenueTotal != null) {
        admobSmall.textContent = (Number(data.admobRevenueTotal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + data.admobCurrencyCode);
        admobSmall.style.display = '';
    } else if (admobSmall) {
        admobSmall.style.display = data.admobCurrencyCode !== 'USD' ? '' : 'none';
    }
}

// User management functions
function editUser(userId) {
    // Show edit user modal or redirect to edit page
    console.log('Editing user:', userId);
    // Implementation would go here
}

function deleteUser(userId) {
    if (confirm('Are you sure you want to delete this user?')) {
        fetch(`/api/users/${userId}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showNotification('User deleted successfully', 'success');
                location.reload();
            } else {
                showNotification('Failed to delete user', 'error');
            }
        })
        .catch(error => {
            console.error('Error deleting user:', error);
            showNotification('Error deleting user', 'error');
        });
    }
}

function toggleUserStatus(userId, currentStatus) {
    const newStatus = !currentStatus;
    
    fetch(`/api/users/${userId}/status`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isActive: newStatus })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('User status updated successfully', 'success');
            location.reload();
        } else {
            showNotification('Failed to update user status', 'error');
        }
    })
    .catch(error => {
        console.error('Error updating user status:', error);
        showNotification('Error updating user status', 'error');
    });
}

// Transaction management functions
function viewTransaction(transactionId) {
    // Show transaction details modal
    console.log('Viewing transaction:', transactionId);
    // Implementation would go here
}

function editTransaction(transactionId) {
    // Show edit transaction modal
    console.log('Editing transaction:', transactionId);
    // Implementation would go here
}

// Support ticket functions
function viewTicket(ticketId) {
    // Show ticket details modal
    console.log('Viewing ticket:', ticketId);
    // Implementation would go here
}

function updateTicketStatus(ticketId, newStatus) {
    fetch(`/api/support/${ticketId}/status`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: newStatus })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('Ticket status updated successfully', 'success');
            location.reload();
        } else {
            showNotification('Failed to update ticket status', 'error');
        }
    })
    .catch(error => {
        console.error('Error updating ticket status:', error);
        showNotification('Error updating ticket status', 'error');
    });
}

// Notification system
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.right = '20px';
    notification.style.padding = '15px 20px';
    notification.style.borderRadius = '8px';
    notification.style.color = 'white';
    notification.style.zIndex = '10000';
    notification.style.maxWidth = '300px';
    notification.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    
    switch (type) {
        case 'success':
            notification.style.background = '#22C55E';
            break;
        case 'error':
            notification.style.background = '#EF4444';
            break;
        case 'warning':
            notification.style.background = '#F59E0B';
            break;
        default:
            notification.style.background = '#3B82F6';
    }
    
    notification.textContent = message;
    document.body.appendChild(notification);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 5000);
    
    // Add click to dismiss
    notification.addEventListener('click', () => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    });
}

// Filter functions
function filterTable(filterType, filterValue) {
    const table = document.querySelector('table tbody');
    if (!table) return;
    
    const rows = table.querySelectorAll('tr');
    rows.forEach(row => {
        if (filterValue === 'all') {
            row.style.display = '';
        } else {
            const cellValue = getCellValue(row, filterType);
            if (cellValue.toLowerCase().includes(filterValue.toLowerCase())) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        }
    });
}

function getCellValue(row, filterType) {
    // Get cell value based on filter type
    const cells = row.querySelectorAll('td');
    switch (filterType) {
        case 'status':
            return cells[4] ? cells[4].textContent : '';
        case 'type':
            return cells[2] ? cells[2].textContent : '';
        case 'priority':
            return cells[3] ? cells[3].textContent : '';
        default:
            return '';
    }
}

// Export functions
function exportData(dataType) {
    console.log('Exporting data:', dataType);
    showNotification('Export functionality will be implemented soon', 'info');
}

// Settings functions
function showTab(tabName) {
    // Hide all tab contents
    const tabContents = document.querySelectorAll('.tab-content');
    tabContents.forEach(content => content.classList.remove('active'));
    
    // Remove active class from all tab buttons
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => btn.classList.remove('active'));
    
    // Show selected tab content
    const selectedTab = document.getElementById(tabName);
    if (selectedTab) {
        selectedTab.classList.add('active');
    }
    
    // Add active class to clicked tab button
    event.target.classList.add('active');
}
