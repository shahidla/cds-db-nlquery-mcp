namespace capdemo;

entity Customers {
  key ID    : String(10);
      NAME  : String(100) @title: 'Customer Name';
      NOTES : String(500);
      FIRST : String(50);
      LAST  : String(50);
      FULL  : String(101) = FIRST || ' ' || LAST;
      orders : Association to many Orders on orders.CUSTOMER_ID = ID;
}
annotate Customers with @cds.search: { NAME, NOTES };

entity Orders {
  key ID          : String(10);
      CUSTOMER_ID : String(10);
      AMOUNT      : Decimal(15,2) @Semantics.amount.currencyCode: 'CURRENCY';
      CURRENCY    : String(3);
      STATUS      : String(1) enum { open = 'O'; closed = 'C'; };
      ORDER_DATE  : Date;
      customer    : Association to Customers on customer.ID = CUSTOMER_ID;
      items       : Composition of many OrderItems on items.ORDER_ID = ID;
}

entity OrderItems {
  key ID       : String(10);
      ORDER_ID : String(10);
      PRODUCT  : String(50);
      QTY      : Integer;
}

entity Accounts {
  key ID        : String(10);
      NAME      : String(100);
      PARENT_ID : String(10);
      parent    : Association to Accounts on parent.ID = PARENT_ID;
      children  : Association to many Accounts on children.PARENT_ID = ID;
}

entity Sectors {
  key CODE        : String(10);
      DESCRIPTION : String(100);
}

entity Loans {
  key ID     : String(10);
      DTI    : Decimal(5,2) @assert.range: [0, 50];
      SECTOR : String(10) @Common.ValueList: {
                 CollectionPath : 'Sectors',
                 Parameters     : [
                   { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: 'SECTOR', ValueListProperty: 'CODE' },
                   { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'DESCRIPTION' },
                 ],
               };
      sector : Association to Sectors on sector.CODE = SECTOR;
}

entity WorkAssignments {
  key ID       : String(10);
      EMPLOYEE : String(50);
      ROLE     : String(50);
      validFrom : Date @cds.valid.from;
      validTo   : Date @cds.valid.to;
}

entity InternalAudit {
  key ID : String(10);
      NOTE : String(200);
}
annotate InternalAudit with @cds.persistence.skip: true;
